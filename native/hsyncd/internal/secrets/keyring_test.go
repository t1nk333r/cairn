package secrets

import "testing"

func TestOriginScopesCredentialToHTTPSOrigin(t *testing.T) {
	origin, err := Origin("https://Git.Example.test:8443/alice/repo.git")
	if err != nil {
		t.Fatal(err)
	}
	if origin != "https://git.example.test:8443" {
		t.Fatalf("unexpected origin: %s", origin)
	}
}

func TestOriginRejectsEmbeddedCredential(t *testing.T) {
	if _, err := Origin("https://token@git.example.test/repo.git"); err == nil {
		t.Fatal("expected credential-bearing URL to fail")
	}
}

func TestCredentialValidationRejectsHeaderInjection(t *testing.T) {
	if _, err := validateCredential("user", "token\r\nInjected: yes"); err == nil {
		t.Fatal("expected newline token to fail")
	}
}
