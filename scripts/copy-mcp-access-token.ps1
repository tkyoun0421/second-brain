[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Get-ProjectEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$EnvironmentPath
  )

  $line = Get-Content -LiteralPath $EnvironmentPath |
    Where-Object { $_ -match ("^{0}=" -f [regex]::Escape($Name)) } |
    Select-Object -First 1

  if ($null -eq $line) {
    throw "Required environment value '$Name' is missing."
  }

  $value = $line.Substring($Name.Length + 1).Trim()
  if ($value.Length -ge 2 -and (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  )) {
    return $value.Substring(1, $value.Length - 2)
  }
  return $value
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
  throw "Project .env file was not found at $environmentPath."
}

$credential = Get-Credential -Message "Enter the mcp_agent email and current password"
$plainPassword = $null
$requestBody = $null
$response = $null

try {
  $supabaseUrl = Get-ProjectEnvironmentValue -Name "SUPABASE_URL" -EnvironmentPath $environmentPath
  $publishableKey = Get-ProjectEnvironmentValue -Name "SUPABASE_PUBLISHABLE_KEY" -EnvironmentPath $environmentPath
  $plainPassword = $credential.GetNetworkCredential().Password
  if ([string]::IsNullOrWhiteSpace($credential.UserName) -or [string]::IsNullOrWhiteSpace($plainPassword)) {
    throw "Email and password are both required."
  }

  $requestBody = @{ email = $credential.UserName; password = $plainPassword } | ConvertTo-Json -Compress
  $response = Invoke-RestMethod -Method Post `
    -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $publishableKey } `
    -ContentType "application/json" `
    -Body $requestBody

  if ([string]::IsNullOrWhiteSpace($response.access_token)) {
    throw "Supabase did not return an access token."
  }

  Set-Clipboard -Value ([string]$response.access_token)
  Write-Host "A new MCP access token was copied to the clipboard. Paste it only into config.toml."
} catch {
  Write-Error "MCP sign-in failed. Check the mcp_agent email and password, then try again."
  exit 1
} finally {
  $plainPassword = $null
  $requestBody = $null
  $response = $null
}
