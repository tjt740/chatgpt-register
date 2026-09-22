package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-register/internal/adobeproducer"
	"chatgpt-register/internal/models"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func testAdobeHandler(t *testing.T) (*Handler, *gin.Engine) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(&models.AdobeRegistration{}, &models.Setting{}); err != nil {
		t.Fatal(err)
	}
	h := &Handler{DB: db, AdobeProducer: adobeproducer.New(db, nil)}
	r := gin.New()
	r.GET("/browser-settings", h.AdobeBrowserSettings)
	r.PUT("/browser-settings", h.AdobeBrowserSettingsSave)
	r.GET("/registrations", h.AdobeList)
	r.POST("/registrations/:id/retry", h.AdobeRetry)
	r.POST("/registrations/:id/stop", h.AdobeStop)
	r.POST("/registrations/livecheck", h.AdobeLiveCheckStart)
	r.POST("/download", h.AdobeDownload)
	return h, r
}
func adobeRequest(r *gin.Engine, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}
func TestAdobeListCapabilitiesDoNotExposeCredentials(t *testing.T) {
	h, r := testAdobeHandler(t)
	regs := []models.AdobeRegistration{
		{Email: "failed@example.com", Status: "register_failed", Password: "secret-pass", Log: "secret-log"},
		{Email: "ready@example.com", Status: "registered", AuthData: `{"cookies":[{"name":"sid","value":"secret-cookie"}]}`},
		{Email: "partial@example.com", Status: "register_failed", AuthData: `{"cookies":[]}`},
	}
	if err := h.DB.Create(&regs).Error; err != nil {
		t.Fatal(err)
	}
	response := adobeRequest(r, http.MethodGet, "/registrations", "")
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	for _, secret := range []string{"secret-pass", "secret-log", "secret-cookie", "auth_data"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
	var payload struct {
		Data []struct {
			ID       uint
			HasAuth  bool `json:"has_auth"`
			CanRetry bool `json:"can_retry"`
		}
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, row := range payload.Data {
		if row.HasAuth != (row.ID == regs[1].ID) || row.CanRetry != (row.ID == regs[0].ID) {
			t.Fatalf("bad capability: %+v", row)
		}
	}
}
func TestAdobeLiveCheckOnlyAcceptsRegisteredUsableSessions(t *testing.T) {
	h, _ := testAdobeHandler(t)
	valid := `{"cookies":[{"name":"sid","value":"test"}]}`
	regs := []models.AdobeRegistration{
		{Email: "failed@example.com", Status: "register_failed", AuthData: valid},
		{Email: "ready@example.com", Status: "registered", AuthData: valid},
		{Email: "empty@example.com", Status: "registered", AuthData: `{"cookies":[]}`},
	}
	if err := h.DB.Create(&regs).Error; err != nil {
		t.Fatal(err)
	}
	items, err := h.loadAdobeItems([]uint{regs[0].ID, regs[1].ID, regs[2].ID})
	if err != nil || len(items) != 1 || items[0].ID != regs[1].ID {
		t.Fatalf("bad selected items: %+v %v", items, err)
	}
	if _, ok := h.loadAdobeItem(regs[0].ID); ok {
		t.Fatal("failed account accepted")
	}
	if _, ok := h.loadAdobeItem(regs[2].ID); ok {
		t.Fatal("empty session accepted")
	}
}
func TestAdobeActionErrorsAndEmptyExports(t *testing.T) {
	h, r := testAdobeHandler(t)
	reg := models.AdobeRegistration{Email: "empty@example.com", Status: "registered", AuthData: `{"cookies":[]}`}
	if err := h.DB.Create(&reg).Error; err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path, body string
		status     int
	}{
		{"/registrations/invalid/retry", "{}", 400},
		{"/registrations/1/retry", "{}", 409}, // 浏览器未就绪
		{"/registrations/1/stop", "{}", 409},
		{"/registrations/livecheck", "invalid", 400},
		{"/download", `{"ids":[1],"format":"string"}`, 400},
	}
	for _, tc := range cases {
		response := adobeRequest(r, "POST", tc.path, tc.body)
		if response.Code != tc.status {
			t.Fatalf("%s: got %d %s", tc.path, response.Code, response.Body.String())
		}
	}
	h.DB.First(&reg, reg.ID)
	if reg.Shipped {
		t.Fatal("failed export marked shipped")
	}
}

func TestAdobeHeadlessDefaultsAndPersists(t *testing.T) {
	h, r := testAdobeHandler(t)
	if got := adobeRequest(r, "GET", "/browser-settings", ""); got.Code != 200 || got.Body.String() != `{"headless":true}` {
		t.Fatal(got.Body.String())
	}
	for _, body := range []string{`{}`, `{"headless":null}`, `{"headless":"false"}`} {
		if got := adobeRequest(r, "PUT", "/browser-settings", body); got.Code != 400 {
			t.Fatal(got.Body.String())
		}
	}
	for _, want := range []bool{false, true} {
		body := `{"headless":false}`
		if want {
			body = `{"headless":true}`
		}
		if got := adobeRequest(r, "PUT", "/browser-settings", body); got.Code != 200 {
			t.Fatal(got.Body.String())
		}
		// 新建 producer 模拟重启，验证保存的是设置而非进程内状态。
		h.AdobeProducer = adobeproducer.New(h.DB, nil)
		if got := adobeRequest(r, "GET", "/browser-settings", ""); got.Body.String() != body {
			t.Fatal(got.Body.String())
		}
	}
}
