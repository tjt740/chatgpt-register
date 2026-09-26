package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// Local source checkouts read assets directly; standalone releases use embedded assets.
func registerStaticRoutes(r *gin.Engine, embedded fs.FS, root string) error {
	assets, err := fs.Sub(embedded, "static")
	if err != nil {
		return err
	}
	local := false
	if os.Getenv("STATIC_MODE") != "embedded" {
		if info, err := os.Stat(filepath.Join(root, "go.mod")); err == nil && !info.IsDir() {
			if info, err := os.Stat(filepath.Join(root, "static")); err == nil && info.IsDir() {
				assets = os.DirFS(filepath.Join(root, "static"))
				local = true
			}
		}
	}
	if local {
		log.Print("local frontend live reload enabled (HTML/CSS/JS); STATIC_MODE=embedded disables it")
		r.GET("/__dev/assets-version", func(c *gin.Context) {
			c.Header("Cache-Control", "no-store")
			version, err := assetVersion(assets)
			if err != nil {
				c.Status(http.StatusServiceUnavailable)
				return
			}
			c.String(http.StatusOK, version)
		})
	}
	noCache := func(c *gin.Context) {
		if local {
			c.Header("Cache-Control", "no-store")
		}
		c.Next()
	}
	r.Group("/static", noCache).StaticFS("", http.FS(assets))
	page := func(name string) gin.HandlerFunc {
		return func(c *gin.Context) {
			if !local {
				c.FileFromFS(name+".html", http.FS(assets))
				return
			}
			c.Header("Cache-Control", "no-store")
			content, err := fs.ReadFile(assets, name+".html")
			if err != nil {
				c.Status(http.StatusNotFound)
				return
			}
			version, err := assetVersion(assets)
			if err != nil {
				c.Status(http.StatusServiceUnavailable)
				return
			}
			script := []byte(fmt.Sprintf(liveReloadScript, version))
			content = bytes.Replace(content, []byte("</body>"), append(script, []byte("</body>")...), 1)
			c.Data(http.StatusOK, "text/html; charset=utf-8", content)
		}
	}
	for _, name := range []string{"login", "dashboard", "mailboxes", "accounts", "grok", "adobe", "leonardo", "lumina", "settings"} {
		r.GET("/"+name, page(name))
	}
	r.GET("/", page("dashboard"))
	return nil
}

func assetVersion(assets fs.FS) (string, error) {
	hash := sha256.New()
	err := fs.WalkDir(assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".html", ".css", ".js":
			content, err := fs.ReadFile(assets, path)
			if err != nil {
				return err
			}
			fmt.Fprintf(hash, "%s\x00%d\x00", path, len(content))
			hash.Write(content)
		}
		return nil
	})
	return fmt.Sprintf("%x", hash.Sum(nil)), err
}

const liveReloadScript = `<script>
(() => {
  const version = %q;
  async function check() {
    try {
      const response = await fetch('/__dev/assets-version', {cache:'no-store'});
      if (response.ok && (await response.text()) !== version) {
        location.reload();
        return;
      }
    } catch (_) {}
    setTimeout(check, 1500);
  }
  setTimeout(check, 1500);
})();
</script>`
