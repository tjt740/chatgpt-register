package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chatgpt-register/internal/mailverify"
	"chatgpt-register/internal/models"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestMailboxImportPreservesParsedFieldsAndSkipsDuplicates(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(&models.Mailbox{}); err != nil {
		t.Fatal(err)
	}
	// 不启动 worker；测试只检查入库与排队，不发出邮箱认证请求。
	verifier := mailverify.New(db, nil, 1)
	t.Cleanup(verifier.Stop)
	h := &Handler{DB: db, MailboxVerifier: verifier}
	r := gin.New()
	r.POST("/api/mailboxes/import", h.MailboxImport)
	body := `{"items":[{"email":"someone@outlook.com","password":"secret;--","client_id":"12345678-1234-1234-1234-123456789abc","refresh_token":"M.Ctest-token-","note":"已购入 | 辅助邮箱：backup@example.com"},{"email":"someone@outlook.com","password":"duplicate"}]}`
	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/mailboxes/import", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		r.ServeHTTP(response, req)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", response.Code, response.Body.String())
		}
		var result struct{ Added, Skipped, Queued int }
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		wantAdded := 1 - attempt
		if result.Added != wantAdded || result.Skipped != 2-wantAdded || result.Queued != wantAdded {
			t.Fatalf("unexpected import counts: %+v", result)
		}
	}
	var mailbox models.Mailbox
	if err := db.First(&mailbox).Error; err != nil {
		t.Fatal(err)
	}
	if mailbox.Password != "secret;--" || mailbox.ClientID != "12345678-1234-1234-1234-123456789abc" || mailbox.RefreshToken != "M.Ctest-token-" || mailbox.Note != "已购入 | 辅助邮箱：backup@example.com" || mailbox.Status != "unverified" {
		t.Fatal("import changed parsed credentials, remarks or queued status")
	}
}
