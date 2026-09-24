$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$aiRoot = Join-Path $projectRoot 'bin/ai'
$pythonRoot = Join-Path $aiRoot 'python'
$scratch = Join-Path $projectRoot '.test-data/studio-setup'
New-Item -ItemType Directory -Force $pythonRoot,$scratch,(Join-Path $aiRoot 'models') | Out-Null
if (!(Test-Path (Join-Path $pythonRoot 'python.exe'))) {
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' -OutFile (Join-Path $scratch 'python.zip')
    Expand-Archive (Join-Path $scratch 'python.zip') $pythonRoot -Force
    Set-Content (Join-Path $pythonRoot 'python311._pth') "python311.zip`n.`nLib/site-packages`nimport site"
    Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile (Join-Path $scratch 'get-pip.py')
    & (Join-Path $pythonRoot 'python.exe') (Join-Path $scratch 'get-pip.py') --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw 'Python setup failed.' }
}
& (Join-Path $pythonRoot 'python.exe') -m pip install --extra-index-url https://download.pytorch.org/whl/cpu -r (Join-Path $projectRoot 'docs/studio-requirements.txt') --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw 'Studio dependency setup failed.' }
$models = @(
    @{Name='GFPGANv1.4.pth'; Url='https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth'; Hash='E2CD4703AB14F4D01FD1383A8A8B266F9A5833DACEE8E6A79D3BF21A1B6BE5AD'},
    @{Name='realesr-general-x4v3.pth'; Url='https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth'; Hash='8DC7EDB9AC80CCDC30C3A5DCA6616509367F05FBC184AD95B731F05BECE96292'}
)
foreach ($model in $models) {
    $target = Join-Path $aiRoot ('models/' + $model.Name)
    if (!(Test-Path $target)) { Invoke-WebRequest $model.Url -OutFile $target }
    if ((Get-FileHash $target -Algorithm SHA256).Hash -ne $model.Hash) { throw ('Model verification failed: ' + $model.Name) }
}
Write-Output 'Studio runtime and official model hashes verified.'
