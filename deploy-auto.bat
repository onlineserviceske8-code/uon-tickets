@echo off
REM Automatic deployment setup for UoN Tickets (Windows)

echo 🚀 Setting up automatic deployment...

REM Check prerequisites
where git >nul 2>nul || (echo ❌ git not installed & exit /b 1)
where gh >nul 2>nul || (echo ❌ GitHub CLI (gh) not installed. Install: https://cli.github.com/ & exit /b 1)

REM Get repo info
for /f "tokens=*" %%a in ('git config --get remote.origin.url 2^>nul') do set REPO_URL=%%a
if "%REPO_URL%"=="" (
    set REPO_NAME=uon-tickets
) else (
    for %%i in ("%REPO_URL%") do set REPO_NAME=%%~ni
)

for /f "tokens=*" %%a in ('gh api user --jq .login 2^>nul') do set GITHUB_USER=%%a

echo 📦 Repository: %GITHUB_USER%/%REPO_NAME%

REM Check for Render API key
if "%RENDER_API_KEY%"=="" (
    echo.
    echo ⚠️  RENDER_API_KEY not set. Get it from: https://dashboard.render.com/account/api-keys
    echo    set RENDER_API_KEY=your-key
    echo.
    echo Manual steps:
    echo 1. Go to https://dashboard.render.com
    echo 2. New → Blueprint
    echo 3. Connect GitHub repo: %GITHUB_USER%/%REPO_NAME%
    echo 4. Render will auto-detect render.yaml
    exit /b 0
)

echo 🔧 Creating Render service...
set PAYLOAD={"type":"web_service","name":"%REPO_NAME%","repo":"https://github.com/%GITHUB_USER%/%REPO_NAME%","branch":"main","rootDir":"mock-server","buildCommand":"npm install","startCommand":"npm start","envVars":[{"key":"NODE_ENV","value":"production"},{"key":"PORT","value":"10000"},{"key":"ADMIN_PASSWORD","generateValue":true},{"key":"ADMIN_SESSION_SECRET","generateValue":true}],"autoDeploy":true}

for /f "tokens=*" %%a in ('curl -s -X POST "https://api.render.com/v1/services" -H "Authorization: Bearer %RENDER_API_KEY%" -H "Content-Type: application/json" -d "%PAYLOAD%"') do set RESPONSE=%%a

echo %RESPONSE% > temp_response.json
for /f "tokens=*" %%a in ('jq -r ".id // empty" temp_response.json') do set SERVICE_ID=%%a
del temp_response.json

if "%SERVICE_ID%"=="" (
    echo ❌ Failed to create service:
    echo %RESPONSE%
    exit /b 1
)

echo ✅ Service created: %SERVICE_ID%

echo 🔐 Setting GitHub secrets...
gh secret set RENDER_SERVICE_ID --body "%SERVICE_ID%"
gh secret set RENDER_API_KEY --body "%RENDER_API_KEY%"

echo.
echo ✅ Automatic deployment configured!
echo.
echo 📋 Next steps:
echo 1. Push to main: git push origin main
echo 2. Watch deploy: https://dashboard.render.com/web/%SERVICE_ID%
echo 3. Admin panel: https://%REPO_NAME%.onrender.com/admin
echo 4. Get admin password: Render Dashboard → Environment → ADMIN_PASSWORD