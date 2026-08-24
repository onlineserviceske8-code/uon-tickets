#!/bin/bash
# Automatic deployment setup for UoN Tickets

set -e

echo "🚀 Setting up automatic deployment..."

# Check prerequisites
command -v git >/dev/null 2>&1 || { echo "❌ git not installed"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "❌ GitHub CLI (gh) not installed. Install: https://cli.github.com/"; exit 1; }

# Get repo name
REPO_NAME=$(basename -s .git $(git config --get remote.origin.url) 2>/dev/null || echo "uon-tickets")
GITHUB_USER=$(gh api user --jq .login)

echo "📦 Repository: $GITHUB_USER/$REPO_NAME"

# Create Render service via API (requires RENDER_API_KEY)
if [ -z "$RENDER_API_KEY" ]; then
  echo ""
  echo "⚠️  RENDER_API_KEY not set. Get it from: https://dashboard.render.com/account/api-keys"
  echo "   export RENDER_API_KEY='your-key'"
  echo ""
  echo "Manual steps:"
  echo "1. Go to https://dashboard.render.com"
  echo "2. New → Blueprint"
  echo "3. Connect GitHub repo: $GITHUB_USER/$REPO_NAME"
  echo "4. Render will auto-detect render.yaml"
  exit 0
fi

# Create service on Render
echo "🔧 Creating Render service..."
SERVICE_RESPONSE=$(curl -s -X POST "https://api.render.com/v1/services" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"web_service\",
    \"name\": \"$REPO_NAME\",
    \"repo\": \"https://github.com/$GITHUB_USER/$REPO_NAME\",
    \"branch\": \"main\",
    \"rootDir\": \"mock-server\",
    \"buildCommand\": \"npm install\",
    \"startCommand\": \"npm start\",
    \"envVars\": [
      {\"key\": \"NODE_ENV\", \"value\": \"production\"},
      {\"key\": \"PORT\", \"value\": \"10000\"},
      {\"key\": \"ADMIN_PASSWORD\", \"generateValue\": true},
      {\"key\": \"ADMIN_SESSION_SECRET\", \"generateValue\": true}
    ],
    \"autoDeploy\": true
  }")

SERVICE_ID=$(echo "$SERVICE_RESPONSE" | jq -r '.id // empty')

if [ -z "$SERVICE_ID" ]; then
  echo "❌ Failed to create service:"
  echo "$SERVICE_RESPONSE" | jq .
  exit 1
fi

echo "✅ Service created: $SERVICE_ID"

# Add GitHub secrets for auto-deploy
echo "🔐 Setting GitHub secrets..."
gh secret set RENDER_SERVICE_ID --body "$SERVICE_ID"
gh secret set RENDER_API_KEY --body "$RENDER_API_KEY"

echo ""
echo "✅ Automatic deployment configured!"
echo ""
echo "📋 Next steps:"
echo "1. Push to main: git push origin main"
echo "2. Watch deploy: https://dashboard.render.com/web/$SERVICE_ID"
echo "3. Admin panel: https://$REPO_NAME.onrender.com/admin"
echo "4. Get admin password: Render Dashboard → Environment → ADMIN_PASSWORD"