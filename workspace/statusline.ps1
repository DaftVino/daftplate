# =============================================================================
# Claude Code status line (Windows / PowerShell 5.1+) — compact, single line.
#
#   model | context-window | context-used% | cost | in/out tokens | agents
#   e.g.  O48 | 245k | 37% | $1.82 | 183k/63k | 2 agents
#
# Reads the status-line JSON on stdin (the payload Claude Code pipes to the
# command configured under settings.json -> statusLine). No external tools,
# no network calls, no API tokens consumed. Pure PowerShell.
#
# FAIL-SAFE CONTRACT:
#   - Never invents values. Absent fields are OMITTED entirely.
#   - No "unknown"/"null"/"n/a"/placeholder text, ever.
#   - No leading, trailing, or doubled separators when fields drop out.
# =============================================================================

# ------------------------------- CONFIG --------------------------------------
function EnvOr($n, $d) { $v = [Environment]::GetEnvironmentVariable($n); if ([string]::IsNullOrEmpty($v)) { $d } else { $v } }

$SEP                  = ' | '
$MODEL_NAME_LEN       = [int](EnvOr 'SL_MODEL_NAME_LEN' '1')   # 1=>"O"; 3=>"Opu"
$MODEL_SHOW_MINOR     = EnvOr 'SL_MODEL_SHOW_MINOR' '1'        # 1=>"O48"; 0=>"O4"
$MODEL_MINOR_SEP      = EnvOr 'SL_MODEL_MINOR_SEP'  ''         # ""=>"O48"; "."=>"O4.8"
$CTX_SIZE_UNIT        = EnvOr 'SL_CTX_SIZE_UNIT' 'tokens'      # tokens | thousands
$TOKENS_INCLUDE_CACHE = EnvOr 'SL_TOKENS_INCLUDE_CACHE' '1'    # 1=>input incl. cache
$COST_EST_MARK        = EnvOr 'SL_COST_EST_MARK' '~'           # marks a calculated cost
$USE_CCUSAGE          = EnvOr 'SL_USE_CCUSAGE' '0'             # 1=>try ccusage fallback
$TRANSCRIPT_CACHE_TTL = [double](EnvOr 'SL_TRANSCRIPT_TTL' '5')
$DEBUG                = EnvOr 'SL_DEBUG' '0'

# Fallback pricing, USD per 1,000,000 tokens, used ONLY when cost.total_cost_usd
# is absent. Order: input, output, cache_write_5m, cache_read.
# Current published list rates (verified Jun 2026). Edit freely.
$PRICING = @{
  'opus'        = @(5,  25, 6.25, 0.50)
  'sonnet'      = @(3,  15, 3.75, 0.30)
  'haiku'       = @(1,   5, 1.25, 0.10)
  'opus-legacy' = @(15, 75, 18.75, 1.50)   # Opus 4 / 4.1
}
# -----------------------------------------------------------------------------

function Dbg($m) { if ($DEBUG -eq '1') { [Console]::Error.WriteLine("statusline: $m") } }
function NumOr($v, $d) { if ($null -eq $v) { $d } else { $v } }
function IsNum($v) {
  if ($null -eq $v) { return $false }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return $true }
  $o = 0.0
  return [double]::TryParse([string]$v, [ref]$o)
}

# Safe nested property access: Get-Prop $obj 'a.b.c' -> value or $null
function Get-Prop($obj, [string]$path) {
  $cur = $obj
  foreach ($part in $path.Split('.')) {
    if ($null -eq $cur) { return $null }
    $p = $cur.PSObject.Properties[$part]
    if ($null -eq $p) { return $null }
    $cur = $p.Value
  }
  return $cur
}

# Compact humaniser: 947 -> "947", 63210 -> "63k", 1240000 -> "1.2M"
function Hum($n) {
  $n = [double]$n
  if ($n -ge 1000000) {
    $v = $n / 1000000.0
    if ($v -eq [math]::Floor($v)) { '{0}M' -f [int]$v } else { '{0:0.0}M' -f $v }
  } elseif ($n -ge 1000) {
    '{0}k' -f [int][math]::Round($n / 1000.0)
  } else {
    '{0}' -f [int]$n
  }
}
function Fmt2($n) { ([double]$n).ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) }

# ------------------------------- read input ----------------------------------
[Console]::InputEncoding  = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
try { $json = $raw | ConvertFrom-Json } catch { exit 0 }

$MODEL_ID    = Get-Prop $json 'model.id'
$MODEL_NAME  = Get-Prop $json 'model.display_name'
$CTX_SIZE    = Get-Prop $json 'context_window.context_window_size'
$CTX_PCT     = Get-Prop $json 'context_window.used_percentage'
$CC_COST     = Get-Prop $json 'cost.total_cost_usd'
$SESSION_ID  = Get-Prop $json 'session_id'
$TRANSCRIPT  = Get-Prop $json 'transcript_path'

# Agent COUNT only from explicit count-like fields — never inferred from agent.name
$AGENT_COUNT = Get-Prop $json 'agent_count'
if ($null -eq $AGENT_COUNT) { $AGENT_COUNT = Get-Prop $json 'active_agents' }
if ($null -eq $AGENT_COUNT) { $ags = Get-Prop $json 'agents'; if ($ags -is [Array]) { $AGENT_COUNT = $ags.Count } }

# ----------------------------- model segment ---------------------------------
$SEG_MODEL = ''
$family = $null; $major = $null; $minor = $null
$src = if ($MODEL_ID) { ($MODEL_ID -replace '^claude-', '') } else { '' }
if ($src -match '^([A-Za-z]+)-([0-9]+)(?:-([0-9]+))?') {
  $family = $matches[1]; $major = $matches[2]; if ($matches[3]) { $minor = $matches[3] }
} elseif ($MODEL_NAME) {
  if ($MODEL_NAME -match '([A-Za-z]+)') { $family = $matches[1] }
  if ($MODEL_NAME -match '([0-9]+)(?:\.([0-9]+))?') { $major = $matches[1]; if ($matches[2]) { $minor = $matches[2] } }
}
if ($family -and $major) {
  $len = [math]::Min($MODEL_NAME_LEN, $family.Length)
  $abbr = $family.Substring(0, $len).ToLower()
  $abbr = $abbr.Substring(0, 1).ToUpper() + $abbr.Substring(1)
  $SEG_MODEL = "$abbr$major"
  if ($MODEL_SHOW_MINOR -eq '1' -and $minor) { $SEG_MODEL = "$SEG_MODEL$MODEL_MINOR_SEP$minor" }
} elseif ($MODEL_NAME) {
  $SEG_MODEL = $MODEL_NAME
}
Dbg "model: id='$MODEL_ID' name='$MODEL_NAME' -> '$SEG_MODEL' (family=$family major=$major minor=$minor)"

# -------------------------- context-window size ------------------------------
$SEG_CTX = ''
if (IsNum $CTX_SIZE) {
  $sz = [double]$CTX_SIZE
  if ($CTX_SIZE_UNIT -eq 'thousands') {
    $k = [int][math]::Round($sz)
  } else {
    $k = [int][math]::Round($sz / 1000.0)
    if ($sz -ge 1 -and $k -lt 1) { $k = 1 }   # floor any nonzero to 1k
  }
  $SEG_CTX = "${k}k"
}

# --------------------------- context used percent ----------------------------
$SEG_PCT = ''
if (IsNum $CTX_PCT) { $SEG_PCT = ('{0}%' -f [int][math]::Round([double]$CTX_PCT)) }

# ------------------- session token totals (from transcript) ------------------
# Claude Code's context_window.total_* fields are CURRENT-CONTEXT counts, not
# cumulative session totals (CC v2.1.132+). For true session in/out totals we
# sum usage across the transcript JSONL, cached per session to stay fast.
$T_IN = 0.0; $T_CW = 0.0; $T_CR = 0.0; $T_OUT = 0.0; $TOK_OK = $false
$sidSafe = if ($SESSION_ID) { ($SESSION_ID -replace '[^A-Za-z0-9._-]', '_') } else { 'nosess' }
$cacheFile = Join-Path $env:TEMP "ccsl-tok-$sidSafe"

function Parse-Transcript($path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  $i = 0.0; $w = 0.0; $r = 0.0; $o = 0.0
  try {
    foreach ($line in [System.IO.File]::ReadLines($path)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      try { $e = $line | ConvertFrom-Json } catch { continue }
      $u = Get-Prop $e 'message.usage'
      if ($u) {
        $i += [double](NumOr (Get-Prop $u 'input_tokens') 0)
        $w += [double](NumOr (Get-Prop $u 'cache_creation_input_tokens') 0)
        $r += [double](NumOr (Get-Prop $u 'cache_read_input_tokens') 0)
        $o += [double](NumOr (Get-Prop $u 'output_tokens') 0)
      }
    }
  } catch { return $null }
  return @($i, $w, $r, $o)
}

$tok = $null
if (Test-Path -LiteralPath $cacheFile) {
  $age = ((Get-Date) - (Get-Item -LiteralPath $cacheFile).LastWriteTime).TotalSeconds
  if ($age -le $TRANSCRIPT_CACHE_TTL) {
    try { $tok = (Get-Content -LiteralPath $cacheFile -Raw) -split ',' } catch { $tok = $null }
  }
}
if (-not $tok) {
  $res = Parse-Transcript $TRANSCRIPT
  if ($res) {
    $tok = $res
    try { [System.IO.File]::WriteAllText($cacheFile, ($res -join ',')) } catch { }
  }
}
if ($tok -and $tok.Count -ge 4) {
  $T_IN = [double]$tok[0]; $T_CW = [double]$tok[1]; $T_CR = [double]$tok[2]; $T_OUT = [double]$tok[3]
  $TOK_OK = $true
}
Dbg "tokens: ok=$TOK_OK in=$T_IN cache_w=$T_CW cache_r=$T_CR out=$T_OUT (src=transcript)"

# ----------------------------- in/out segment --------------------------------
$SEG_TOK = ''
if ($TOK_OK) {
  if ($TOKENS_INCLUDE_CACHE -eq '1') { $din = $T_IN + $T_CW + $T_CR } else { $din = $T_IN }
  $dout = $T_OUT
  if (($din + $dout) -gt 0) { $SEG_TOK = (Hum $din) + '/' + (Hum $dout) }
}

# -------------------------------- cost ---------------------------------------
# Path priority (explicit & auditable):
#   1. Claude Code's own cost.total_cost_usd        -> plain   ($1.82)
#   2. calculated from session tokens x pricing      -> marked  (~$1.82)
#   3. ccusage (only if SL_USE_CCUSAGE=1)            -> marked  (~$1.82)
#   4. nothing determinable -> cost omitted
$SEG_COST = ''; $COST_SRC = ''

if ((IsNum $CC_COST) -and ([double]$CC_COST -gt 0)) {
  $SEG_COST = '$' + (Fmt2 $CC_COST)
  $COST_SRC = 'claude-code (cost.total_cost_usd)'
} elseif ($TOK_OK -and $family) {
  $key = $family.ToLower()
  $rates = $PRICING[$key]
  if ($key -eq 'opus' -and $major -eq '4') {
    if (-not $minor -or [int]$minor -le 1) { $rates = $PRICING['opus-legacy'] }
  }
  if ($rates) {
    $est = (($T_IN * $rates[0]) + ($T_CW * $rates[2]) + ($T_CR * $rates[3]) + ($T_OUT * $rates[1])) / 1000000.0
    $SEG_COST = $COST_EST_MARK + '$' + (Fmt2 $est)
    $COST_SRC = "calculated (pricing table, family=$key)"
  }
}

if (-not $SEG_COST -and $USE_CCUSAGE -eq '1') {
  if (Get-Command ccusage -ErrorAction SilentlyContinue) {
    try {
      $j = (& ccusage session --json 2>$null) | Out-String
      if (-not $j.Trim()) { $j = (& ccusage --json 2>$null) | Out-String }
      $cu = $j | ConvertFrom-Json
      $sessions = if (Get-Prop $cu 'sessions') { (Get-Prop $cu 'sessions') } else { $cu }
      $row = $null
      if ($sessions -is [Array]) {
        $row = $sessions | Where-Object { (NumOr (Get-Prop $_ 'sessionId') (Get-Prop $_ 'session_id')) -eq $SESSION_ID } | Select-Object -First 1
        if (-not $row) { $row = $sessions[-1] }
      } else { $row = $sessions }
      $cval = NumOr (Get-Prop $row 'totalCost') (NumOr (Get-Prop $row 'total_cost') (Get-Prop $row 'cost'))
      if (IsNum $cval) { $SEG_COST = $COST_EST_MARK + '$' + (Fmt2 $cval); $COST_SRC = 'calculated (ccusage)' }
    } catch { }
  }
}
Dbg "cost: '$SEG_COST' src='$COST_SRC'"

# ------------------------------- agents --------------------------------------
$SEG_AGENTS = ''
if ((IsNum $AGENT_COUNT)) {
  $n = [int]$AGENT_COUNT
  if ($n -gt 0) { if ($n -eq 1) { $SEG_AGENTS = '1 agent' } else { $SEG_AGENTS = "$n agents" } }
}

# ------------------------------- assemble ------------------------------------
$segs = @()
foreach ($s in @($SEG_MODEL, $SEG_CTX, $SEG_PCT, $SEG_COST, $SEG_TOK, $SEG_AGENTS)) {
  if ($s) { $segs += $s }
}
[Console]::Out.WriteLine(($segs -join $SEP))
