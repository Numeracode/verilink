{{/*
Expand the name of the chart.
*/}}
{{- define "verilink.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app names.
*/}}
{{- define "verilink.controlPlane.fullname" -}}
{{- printf "%s-control-plane" (include "verilink.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "verilink.trustEngine.fullname" -}}
{{- printf "%s-trust-engine" (include "verilink.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "verilink.edgeVerifier.fullname" -}}
{{- printf "%s-edge-verifier" (include "verilink.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "verilink.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: verilink
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "verilink.controlPlane.selectorLabels" -}}
app.kubernetes.io/name: verilink-control-plane
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "verilink.trustEngine.selectorLabels" -}}
app.kubernetes.io/name: verilink-trust-engine
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "verilink.edgeVerifier.selectorLabels" -}}
app.kubernetes.io/name: verilink-edge-verifier
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Image helper: uses global registry if set.
*/}}
{{- define "verilink.image" -}}
{{- $registry := .registry -}}
{{- $repo := .repository -}}
{{- $tag := .tag | default .appVersion -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}
