# PoC 仮想環境セットアップ (Windows PowerShell)
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Write-Host "セットアップ完了。以降は .\.venv\Scripts\Activate.ps1 で仮想環境を有効化してください。" -ForegroundColor Green
