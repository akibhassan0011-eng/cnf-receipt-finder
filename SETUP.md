# C&F Receipt Finder: Setup Guide (Proxy + GitHub Pages)

```
Browser (GitHub Pages dashboard, https)
      │  x-api-key
      ▼
Proxy server (VPS, Node.js)  ── portal-e auto login, session rakhe
      │  http
      ▼
C&F Portal (122.152.50.54:81)
```

Folder structure:
```
cnf-receipt-finder/
├── server/        <- VPS-e chalbe (server.js, package.json, .env.example)
├── docs/          <- GitHub Pages dashboard (index.html)
└── .gitignore
```

---

## Step 1: GitHub repo + dashboard

1. GitHub-e notun repo banan (jemon `cnf-receipt-finder`).
2. Ei folder-er shob file upload/push korun. **`.env` file kokhono push korben na** (`.gitignore` already block kore).
3. Repo → **Settings → Pages** → Source: `Deploy from a branch`, Branch: `main`, Folder: `/docs` → Save.
4. 1-2 minute por dashboard link pabên: `https://YOUR_USERNAME.github.io/cnf-receipt-finder/`

## Step 2: VPS nin

Ekta chhoto VPS (Ubuntu 22.04/24.04, 1 GB RAM-i jothesto): DigitalOcean, Hetzner, Vultr ityadi, ~$4-6/month.

> Portal public, tai VPS jekono country-te hole cholbe. Jodi kono din portal off/slow thake, proxy-o error dekhabe.

## Step 3: VPS-e Node.js ar code boshan

SSH diye VPS-e dhuke:

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# code nin
git clone https://github.com/YOUR_USERNAME/cnf-receipt-finder.git
cd cnf-receipt-finder/server

# .env banan
cp .env.example .env
nano .env
```

`.env`-e boshan:
- `PORTAL_USER` / `PORTAL_PASS` : portal-er login
- `API_KEY` : lomba random secret. Banate: `openssl rand -hex 24`
- `ALLOWED_ORIGIN` : `https://YOUR_USERNAME.github.io` (shesh-e `/` nai, repo name nai)

Chalie dekhun:
```bash
node server.js
```
Dekhben: `Proxy listening on port 3000`. (Ctrl+C diye thamun, ekhon permanent korbo.)

## Step 4: Server sob somoy chalu rakhun (pm2)

```bash
sudo npm install -g pm2
cd ~/cnf-receipt-finder/server
pm2 start server.js --name cnf-proxy
pm2 save
pm2 startup        # je command dekhabe seta copy kore chalan
```

## Step 5: HTTPS link nin (Cloudflare Tunnel)

GitHub Pages `https`, tai proxy-r link-o `https` hote hobe.

**Shohoj (test-er jonno, domain lagbe na):**
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel --url http://localhost:3000
```
Ekta `https://something.trycloudflare.com` link dekhabe. Eta-i apnar Proxy URL.
Dhyan: ei link tunnel restart hole bodle jay.

**Permanent link chaile:** nijer ekta domain Cloudflare-e boshiye "named tunnel" banan (Cloudflare Zero Trust → Networks → Tunnels), ba VPS-e Caddy diye domain + auto-HTTPS boshan.

Tunnel-ke pm2 diye chalate chaile:
```bash
pm2 start "cloudflared tunnel --url http://localhost:3000" --name cnf-tunnel
pm2 logs cnf-tunnel    # ekhane link dekhabe
pm2 save
```

## Step 6: Dashboard use korun

1. `https://YOUR_USERNAME.github.io/cnf-receipt-finder/` kholun.
2. **Server সংযোগ**-e Proxy URL ar API Key boshan → **সংযোগ পরীক্ষা**. "✅ সংযোগ ঠিক আছে" dekhale ready.
3. Name / AIN / Barcode, Starting ID dিয়ে **Start**.
4. Match hole ডান পাশে receipt dekhabe. **Stop** diye jekono somoy thamano jay.

Browser-e API key save thake (shudhu oi browser-e). Public/shared computer-e use korle kaj shesh e browser data clear korun.

---

## Nirapotta

- **`.env` GitHub-e push korben na.** Vul kore push hoye gele sathe sathe portal password bodlan ar API key bodlan.
- API key lomba rakhun. Proxy URL jar kache ache, key chhara se kichu dekhte parbe na.
- Portal-er password chat/email-e pathaben na.
- "একসাথে কয়টা" 3-5 er beshi korben na, portal-er upor chap pore.
- Portal-er owner/office-er policy-te automated login ar bulk fetch-er onumoti ache kina ta ekbar nishchit korun.

## Somossha hole

| Lokkhon | Kaaron / Somadhan |
|---|---|
| "সংযোগ পরীক্ষা" e `Failed to fetch` | Proxy URL vul, proxy chalu nai, ba `ALLOWED_ORIGIN` vul. `pm2 logs cnf-proxy` dekhun |
| "API key thik nai" | Dashboard-er key ar `.env`-er `API_KEY` mile nai |
| "Portal login fail" | `.env`-er `PORTAL_USER`/`PORTAL_PASS` vul |
| Shob ID "ফাঁকা" | Receipt-er URL/ID range vul, ba portal-e oi ID nai |
| Name milche na | Spelling mile kina dekhun. Space/punctuation ignore hoy, kintu spelling mile thakte hobe |
| `.env` change korar por kaj kore na | `pm2 restart cnf-proxy` |

---

## Purano Tampermonkey version

`cnf-receipt-finder.user.js` (agey dewa) ei proxy-r poriborte portal-er bhitor-i chole. Proxy setup korle eta lagbe na.
