package adobeproducer

import (
	"chatgpt-register/internal/adobereg"
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"chatgpt-register/internal/models"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func testProducer(t *testing.T) *Producer {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err := db.AutoMigrate(&models.Registration{}, &models.AdobeRegistration{}, &models.Mailbox{}, &models.Setting{}); err != nil {
		t.Fatal(err)
	}
	return New(db, nil)
}
func createTestReg(t *testing.T, p *Producer, reg *models.AdobeRegistration) {
	t.Helper()
	if err := p.db.Create(reg).Error; err != nil {
		t.Fatal(err)
	}
}
func TestClaimRetryPreservesIdentityAndHistory(t *testing.T) {
	p := testProducer(t)
	checked := time.Now()
	reg := models.AdobeRegistration{Email: "retry@example.com", Password: "original-password", FirstName: "abc", LastName: "abc", CountryCode: "SG", BirthYear: 1995, BirthMonth: 8, MailboxID: 12, Status: "register_failed", Log: "previous failure", Shot: []byte{1}, Alive: "dead", AliveCheckedAt: &checked, Shipped: true}
	createTestReg(t, p, &reg)
	retried, err := p.claimOne(reg.Email, 0, "manual retry")
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != reg.ID || retried.MailboxID != 12 || retried.Password != reg.Password || !retried.CreatedAt.Equal(reg.CreatedAt) {
		t.Fatalf("retry changed identity: %+v", retried)
	}
	if retried.FirstName != reg.FirstName || retried.LastName != reg.LastName || retried.CountryCode != reg.CountryCode || retried.BirthYear != reg.BirthYear || retried.BirthMonth != reg.BirthMonth {
		t.Fatal("retry changed personal details")
	}
	if retried.Status != "registering" || !strings.Contains(retried.Log, "previous failure") || !strings.Contains(retried.Log, "重新尝试") {
		t.Fatalf("retry missing status/history: %+v", retried)
	}
	if retried.Alive != "" || retried.AliveCheckedAt != nil || retried.Shipped || len(retried.Shot) > 0 {
		t.Fatal("stale results were retained")
	}
	if _, err := p.claimOne(reg.Email, 0, ""); err == nil {
		t.Fatal("duplicate active retry was accepted")
	}
	var n int64
	p.db.Model(&models.AdobeRegistration{}).Count(&n)
	if n != 1 {
		t.Fatalf("created duplicate records: %d", n)
	}
}
func TestRetryRejectsProtectedStates(t *testing.T) {
	for _, status := range []string{"registered", "registering", "waiting_code", "register_failed"} {
		t.Run(status, func(t *testing.T) {
			p := testProducer(t)
			reg := models.AdobeRegistration{Email: "protected@example.com", Status: status, Password: "keep", AuthData: `{"cookies":[{"name":"sid","value":"keep"}]}`, Shipped: true}
			createTestReg(t, p, &reg)
			if _, err := p.Retry(reg.ID); err == nil {
				t.Fatal("protected record accepted")
			}
			var got models.AdobeRegistration
			p.db.First(&got, reg.ID)
			if got.Password != reg.Password || got.AuthData != reg.AuthData || got.Status != reg.Status || !got.Shipped {
				t.Fatal("protected record modified")
			}
		})
	}
}
func TestConcurrentClaimsOnlyOneWins(t *testing.T) {
	p := testProducer(t)
	reg := models.AdobeRegistration{Email: "concurrent@example.com", Status: "register_failed"}
	createTestReg(t, p, &reg)
	results := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := p.claimOne(reg.Email, 0, ""); results <- err }()
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("claims succeeded %d times", successes)
	}
}
func TestRetryCanBeStoppedImmediatelyWhileQueued(t *testing.T) {
	p := testProducer(t)
	// 占用唯一执行槽，测试只验证排队/取消，不启动浏览器或访问 Adobe。
	if !p.AcquireSlot(context.Background(), nil) {
		t.Fatal("cannot occupy slot")
	}
	defer p.ReleaseSlot()
	reg := models.AdobeRegistration{Email: "queued@example.com", Status: "register_failed", Password: "keep"}
	createTestReg(t, p, &reg)
	if _, err := p.Retry(reg.ID); err != nil {
		t.Fatal(err)
	}
	if p.runningNum() != 1 {
		t.Fatal("task not registered before returning")
	}
	p.Stop(reg.ID)
	deadline := time.Now().Add(3 * time.Second)
	for p.runningNum() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.runningNum() != 0 {
		t.Fatal("queued task did not stop")
	}
	var got models.AdobeRegistration
	p.db.First(&got, reg.ID)
	if got.Status != "register_failed" || got.Note != "已取消" {
		t.Fatalf("unexpected canceled state: %s %s", got.Status, got.Note)
	}
}

func TestExistingAdobeAccountIsSkippedAndNeverReclaimed(t *testing.T) {
	p := testProducer(t)
	reg := models.AdobeRegistration{Email: "existing@example.com", Password: "preserve", Status: "registering", Log: "history"}
	createTestReg(t, p, &reg)
	p.finishRegistrationError(reg.ID, fmt.Errorf("validation: %w", adobereg.ErrAccountExists))
	var got models.AdobeRegistration
	p.db.First(&got, reg.ID)
	if got.Status != "skipped" || got.Password != "preserve" || got.AuthData != "" || !strings.Contains(got.Log, "已跳过") {
		t.Fatalf("bad skip state: %+v", got)
	}
	if _, err := p.Retry(reg.ID); err == nil {
		t.Fatal("skipped account can be retried")
	}
	snapshot := p.Snapshot()
	if snapshot.Skipped != 1 || snapshot.Failed != 0 || snapshot.Registered != 1 {
		t.Fatalf("wrong totals: %+v", snapshot)
	}
	if err := p.db.Create(&models.Mailbox{Email: reg.Email, Status: "verified"}).Error; err != nil {
		t.Fatal(err)
	}
	claimed, cooling, err := p.claimTargets(1)
	if err != nil || cooling || len(claimed) != 0 {
		t.Fatalf("skipped account requeued: %v %v %v", claimed, cooling, err)
	}
}
