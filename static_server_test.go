package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func TestLocalAssetsReloadWithoutRestart(t *testing.T) {
	t.Setenv("STATIC_MODE", "")
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "static"), 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("go.mod", "module preview")
	write("static/adobe.html", "<body>local</body>")
	write("static/style.css", "body{color:red}")
	r := gin.New()
	if err := registerStaticRoutes(r, fstest.MapFS{}, root); err != nil {
		t.Fatal(err)
	}
	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		r.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, response.Code)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s cached", path)
		}
		return response
	}
	before := get("/__dev/assets-version").Body.String()
	html := get("/adobe").Body.String()
	if !strings.Contains(html, before) || !strings.Contains(html, "location.reload()") {
		t.Fatal("missing live reload script/version")
	}
	if body := get("/static/style.css?v=1").Body.String(); body != "body{color:red}" {
		t.Fatal(body)
	}
	// Same-length edits with unchanged timestamps must still invalidate the version.
	info, _ := os.Stat(filepath.Join(root, "static/style.css"))
	write("static/style.css", "body{color:tan}")
	if err := os.Chtimes(filepath.Join(root, "static/style.css"), info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if before == get("/__dev/assets-version").Body.String() {
		t.Fatal("edit did not change version")
	}
	if body := get("/static/style.css?v=1").Body.String(); body != "body{color:tan}" {
		t.Fatal("stale asset: " + body)
	}
	write("static/adobe.html", "<body>updated</body>")
	if !strings.Contains(get("/adobe").Body.String(), "updated") {
		t.Fatal("stale HTML")
	}
	write("static/new.js", "console.log('new')")
	added := get("/__dev/assets-version").Body.String()
	if err := os.Remove(filepath.Join(root, "static/new.js")); err != nil {
		t.Fatal(err)
	}
	if added == get("/__dev/assets-version").Body.String() {
		t.Fatal("deletion did not change version")
	}
}

func TestEmbeddedAssetsRemainStandalone(t *testing.T) {
	for _, mode := range []string{"", "embedded"} {
		t.Run("mode="+mode, func(t *testing.T) {
			t.Setenv("STATIC_MODE", mode)
			root := t.TempDir()
			if mode == "embedded" {
				if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module ignored"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(root, "static"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			var embedded fs.FS = fstest.MapFS{"static/adobe.html": {Data: []byte("<body>embedded</body>")}}
			r := gin.New()
			if err := registerStaticRoutes(r, embedded, root); err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			r.ServeHTTP(response, httptest.NewRequest("GET", "/adobe", nil))
			if response.Code != 200 || response.Body.String() != "<body>embedded</body>" {
				t.Fatal(response)
			}
			response = httptest.NewRecorder()
			r.ServeHTTP(response, httptest.NewRequest("GET", "/__dev/assets-version", nil))
			if response.Code != 404 {
				t.Fatal("development endpoint enabled in embedded mode")
			}
		})
	}
}
