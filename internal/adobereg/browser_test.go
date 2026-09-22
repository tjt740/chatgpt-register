package adobereg

import (
	"context"
	"errors"
	"testing"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher/flags"
)

func TestAdobeLauncherBrowserMode(t *testing.T) {
	for _, headless := range []bool{false, true} {
		name := "visible"
		if headless {
			name = "headless"
		}
		t.Run(name, func(t *testing.T) {
			l := newAdobeLauncher(headless)
			values, present := l.GetFlags(flags.Headless)
			if present != headless {
				t.Fatalf("headless flag present = %v, want %v", present, headless)
			}
			if headless && (len(values) != 1 || values[0] != "new") {
				t.Fatalf("headless mode = %v, want [new]", values)
			}
		})
	}
}

func TestGotoCreateFormAlreadyCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// 已取消时不应再连接浏览器、重新导航或把取消误报为表单加载失败。
	if err := gotoCreateForm(ctx, &rod.Page{}, Input{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v, want context.Canceled", err)
	}
}

func TestAdobeLandingDoesNotAcceptLoginOrLookalike(t *testing.T) {
	for _, tc := range []struct {
		url            string
		adobe, landing bool
	}{
		{"https://account.adobe.com/", true, true},
		{"https://firefly.adobe.com/", true, true},
		{"https://auth.services.adobe.com/zh_HANS/deeplink.html#/", true, false},
		{"https://account.adobe.com/#/signup", true, false},
		{"https://account.adobe.com/sign-in", true, false},
		{"https://ims-na1.adobelogin.com/ims/authorize", true, false},
		{"https://adobe.com.evil.test/", false, false},
		{"https://evil.test/?next=account.adobe.com", false, false},
		{"http://account.adobe.com/", false, false},
	} {
		if isAdobeURL(tc.url) != tc.adobe || isAdobeAccountLanding(tc.url) != tc.landing {
			t.Errorf("wrong state for %s", tc.url)
		}
	}
}
func TestProfileDefaultsAndPreservation(t *testing.T) {
	for i := 0; i < 100; i++ {
		in := Input{FirstName: "abc", LastName: "abc"}
		FillProfileDefaults(&in)
		if in.FirstName != "abc" || in.LastName != "abc" || in.CountryCode != "SG" || in.BirthYear < 1990 || in.BirthYear > 1999 || in.BirthMonth < 1 || in.BirthMonth > 12 {
			t.Fatalf("bad profile: %+v", in)
		}
		oldYear, oldMonth := in.BirthYear, in.BirthMonth
		FillProfileDefaults(&in)
		if in.BirthYear != oldYear || in.BirthMonth != oldMonth {
			t.Fatal("profile changed on retry")
		}
	}
}

func TestAdobeFormErrors(t *testing.T) {
	for _, tc := range []struct {
		text string
		want error
	}{
		{"已经存在一个使用此电子邮件地址的帐户。", ErrAccountExists},
		{"An account with this email address already exists.", ErrAccountExists},
		{"这是错误的密码。请重试。", errAdobePassword},
		{"Incorrect password. Try again.", errAdobePassword},
		{"已经有帐户？ 登录", nil},
		{"创建帐户", nil},
	} {
		if got := classifyAdobeFormError(tc.text); !errors.Is(got, tc.want) {
			t.Errorf("%s: %v", tc.text, got)
		}
	}
}

func TestEmailCodeSendPrompt(t *testing.T) {
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"Verify your identity. To confirm your identity we'll send you a verification code to K***@o***.com", true},
		{"为了确认您的身份，我们将向您的邮箱发送验证码", true},
		{"Enter the code we sent to your email", false},
		{"Please solve a few puzzles", false},
	} {
		if isEmailCodePromptText(tc.text) != tc.want {
			t.Errorf("bad email prompt classification: %s", tc.text)
		}
	}
}

func TestFillInputCanceledBeforeBrowserAccess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fillInput(ctx, &rod.Page{}, "input", "value", 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}
