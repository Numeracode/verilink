package fingerprint

import (
	"testing"
)

func TestGenerate_Determinism(t *testing.T) {
	data := RequestData{
		JA4: "t13d311100_0013_150a",
		Headers: map[string]string{
			"User-Agent": "VeriLinkAgent/1.0",
			"Accept":     "application/json",
		},
		Protocol: "h2",
	}

	fp1, err := Generate(data)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	fp2, err := Generate(data)
	if err != nil {
		t.Fatalf("Generate failed: %v", err)
	}

	if fp1 != fp2 {
		t.Errorf("Fingerprints are not deterministic: %s != %s", fp1, fp2)
	}
}

func TestGenerate_HeaderOrderIndependence(t *testing.T) {
	data1 := RequestData{
		Headers: map[string]string{
			"A": "1",
			"B": "2",
		},
	}
	data2 := RequestData{
		Headers: map[string]string{
			"B": "2",
			"A": "1",
		},
	}

	fp1, _ := Generate(data1)
	fp2, _ := Generate(data2)

	if fp1 != fp2 {
		t.Errorf("Fingerprints should be independent of header map order: %s != %s", fp1, fp2)
	}
}

func TestGenerate_CaseInsensitivity(t *testing.T) {
	data1 := RequestData{
		JA4:      "T13D311100",
		Protocol: "H2",
	}
	data2 := RequestData{
		JA4:      "t13d311100",
		Protocol: "h2",
	}

	fp1, _ := Generate(data1)
	fp2, _ := Generate(data2)

	if fp1 != fp2 {
		t.Errorf("Fingerprints should be case-insensitive for JA4 and Protocol: %s != %s", fp1, fp2)
	}
}
