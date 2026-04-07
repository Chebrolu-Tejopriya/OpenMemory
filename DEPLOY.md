# Free Deployment Guide

Deploy OpenMemory for **$0/month** using Vercel (webapp) + Render (backend).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     Vercel      │     │     Render      │     │    Supabase     │
│    (Webapp)     │────▶│    (Backend)    │────▶│   (Database)    │
│   Next.js App   │     │ Node.js+Python  │     │    pgvector     │
│      FREE       │     │      FREE       │     │      FREE       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Step 1: Deploy Backend on Render

### 1.1 Create Render Account
1. Go to [render.com](https://render.com) and sign up (free)
2. Connect your GitHub account

### 1.2 Create Web Service
1. Click **New → Web Service**
2. Connect your `OpenMemory` repository
3. Configure:
   - **Name**: `openmemory-backend`
   - **Root Directory**: `backend`
   - **Environment**: `Node`
   - **Build Command**:
     ```
     npm install && npm run build && pip install -r python/requirements.txt
     ```
   - **Start Command**: `node dist/server.js`
   - **Plan**: Free

### 1.3 Set Environment Variables
In Render dashboard, add these environment variables:
| Key | Value |
|-----|-------|
| `PORT` | `3001` |
| `SUPABASE_URL` | `https://ghfybenvdenuupiqgouf.supabase.co` |
| `SUPABASE_ANON_KEY` | Your Supabase anon key |
| `NODE_ENV` | `production` |

### 1.4 Deploy
Click **Create Web Service**. Wait for build to complete (~5-10 min).

Your backend URL will be: `https://openmemory-backend.onrender.com`

---

## Step 2: Deploy Webapp on Vercel

### 2.1 Create Vercel Account
1. Go to [vercel.com](https://vercel.com) and sign up (free)
2. Connect your GitHub account

### 2.2 Import Project
1. Click **Add New → Project**
2. Import your `OpenMemory` repository
3. Configure:
   - **Framework Preset**: Next.js
   - **Root Directory**: `webapp`

### 2.3 Set Environment Variables
Add this environment variable:
| Key | Value |
|-----|-------|
| `NEXT_PUBLIC_BACKEND_URL` | `https://openmemory-backend.onrender.com` |

### 2.4 Deploy
Click **Deploy**. Wait for build to complete (~2-3 min).

Your webapp URL will be: `https://openmemory.vercel.app`

---

## Free Tier Limitations

### Render (Backend)
- ⚠️ **Spins down after 15 min of inactivity**
- First request after sleep takes ~30-60 seconds (cold start)
- 750 hours/month (enough for 1 service 24/7)

### Vercel (Webapp)
- ✅ No sleep/cold start issues
- Unlimited bandwidth for hobby projects
- 100GB bandwidth/month

### Supabase (Database)
- ✅ Always available
- 500MB database storage
- 2GB bandwidth/month

---

## Keeping Backend Awake (Optional)

To avoid cold starts, set up a free cron job to ping your backend every 14 minutes:

### Using cron-job.org (Free)
1. Go to [cron-job.org](https://cron-job.org)
2. Create account and add new cron job:
   - **URL**: `https://openmemory-backend.onrender.com/health`
   - **Schedule**: Every 14 minutes

### Or use UptimeRobot (Free)
1. Go to [uptimerobot.com](https://uptimerobot.com)
2. Add HTTP monitor for your backend URL

---

## Troubleshooting

### Backend not responding
- Check Render logs for errors
- Verify environment variables are set correctly
- First request after sleep takes 30-60s

### Webapp can't connect to backend
- Verify `NEXT_PUBLIC_BACKEND_URL` is set correctly in Vercel
- Check that backend URL doesn't have trailing slash
- Redeploy webapp after changing env vars

### Search returns no results
- Check Supabase connection in Render logs
- Verify SUPABASE_URL and SUPABASE_ANON_KEY are correct

---

## Estimated Costs

| Service | Plan | Cost |
|---------|------|------|
| Vercel | Hobby | $0 |
| Render | Free | $0 |
| Supabase | Free | $0 |
| **Total** | | **$0/month** |
