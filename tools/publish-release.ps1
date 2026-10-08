param(
  # Draft: create/refresh the release and upload the asset, but leave it unpublished.
  # Publish: also flip an existing draft to published.
  [ValidateSet('Draft', 'Publish')]
  [string]$Mode = 'Draft',
  [string]$Owner = 'riceyu02',
  [string]$Repository = 'dsh-desktop-pet'
)

<#
  Publish a release from a machine that cannot use git over https://github.com
  (the plain github.com host is unreachable from some networks while api.github.com
  and uploads.github.com are fine). Everything here goes through the REST API, using
  the GitHub token already stored by Git Credential Manager.

  Build the installer first:  npm run build:dsh-plugin
  Then:                       powershell -File tools/publish-release.ps1 -Mode Draft
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$tag = "v$version"
$assetName = "$($manifest.name)-$version.tgz"
$assetPath = Join-Path $root "artifacts\$assetName"
$apiBase = "https://api.github.com/repos/$Owner/$Repository"

if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
  throw "Installer not found: $assetPath`nBuild it first: npm run build:dsh-plugin"
}

$sha256 = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash
$assetBytes = (Get-Item -LiteralPath $assetPath).Length

# The token lives in Git Credential Manager; ask git for it instead of storing it here.
$credentialInput = "protocol=https`nhost=github.com`n`n"
$credentialLines = $credentialInput | & git credential fill
$credential = @{}
foreach ($line in $credentialLines) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { $credential[$line.Substring(0, $separator)] = $line.Substring($separator + 1) }
}
$token = $credential['password']
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Git Credential Manager did not return a GitHub token.' }
if (-not [string]::IsNullOrWhiteSpace($credential['username'])) { $Owner = $credential['username'] }

$headers = @{
  Accept                 = 'application/vnd.github+json'
  Authorization          = "Bearer $token"
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'dsh-desktop-pet-release-helper'
}

$notes = @"
发布 $tag。

### 安装

下载附件 ``$assetName``，然后：

``````powershell
dsh plugin --profile desktop add "<下载目录>\$assetName"
``````

也可以直接让 DSH 去取：

``````powershell
dsh plugin --profile desktop add https://github.com/$Owner/$Repository/releases/download/$tag/$assetName
``````

装完**完全退出并重新打开** DeepSeek Harness。

### 校验

SHA256: ``$sha256``

> Windows 10/11；第三方社区插件，与 DeepSeek AI 无隶属、认可或合作关系。
"@

try {
  $releases = Invoke-RestMethod -Uri "$apiBase/releases?per_page=100" -Headers $headers -Method Get
  $release = $releases | Where-Object { $_.tag_name -eq $tag } | Select-Object -First 1

  if ($Mode -eq 'Draft') {
    if (-not $release) {
      $body = @{
        tag_name         = $tag
        target_commitish = 'main'
        name             = "DSH 悬浮球桌宠 $tag"
        body             = $notes
        draft            = $true
        prerelease       = $false
      } | ConvertTo-Json -Depth 4

      $release = Invoke-RestMethod -Uri "$apiBase/releases" -Headers $headers -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    }

    if (-not $release.draft) {
      Write-Output "RELEASE_ALREADY_PUBLISHED=$($release.html_url)"
    }
    else {
      $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
      if ($asset) {
        if ($asset.size -ne $assetBytes) {
          throw "Release already carries $assetName with a different size ($($asset.size) vs $assetBytes); delete that asset first."
        }
      }
      else {
        $uploadBase = $release.upload_url -replace '\{\?name,label\}$', ''
        $uploadUri = "$uploadBase`?name=$([Uri]::EscapeDataString($assetName))"
        $asset = Invoke-RestMethod -Uri $uploadUri -Headers $headers -Method Post `
          -ContentType 'application/gzip' -InFile $assetPath
      }
      Write-Output "RELEASE_ID=$($release.id)"
      Write-Output "DRAFT=$($release.draft)"
      Write-Output "ASSET=$($asset.name) ($($asset.size) bytes)"
      Write-Output "DRAFT_URL=https://github.com/$Owner/$Repository/releases/edit/$tag"
    }
  }
  else {
    if (-not $release) { throw "No release found for $tag." }
    if (-not $release.draft) {
      Write-Output "RELEASE_ALREADY_PUBLISHED=$($release.html_url)"
    }
    else {
      $publishBody = @{ draft = $false } | ConvertTo-Json
      $published = Invoke-RestMethod -Uri "$apiBase/releases/$($release.id)" -Headers $headers -Method Patch `
        -ContentType 'application/json; charset=utf-8' -Body $publishBody
      Write-Output "PUBLISHED_URL=$($published.html_url)"
    }
  }

  Write-Output "INSTALL_SPEC=https://github.com/$Owner/$Repository/releases/download/$tag/$assetName"
  Write-Output "SHA256=$sha256"
}
finally {
  $token = $null
  $credential.Clear()
  $credentialLines = $null
}
