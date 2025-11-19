# Fly Voice Agent

> Multi-tenant voice AI platform with real-time conversation capabilities

**Live Demo:** https://voice-agent.cameronobrien.dev

A production-ready voice AI platform deployed on Fly.io that provides intelligent phone conversations using Twilio Media Streams, speech-to-text (Deepgram), AI reasoning (Groq), and text-to-speech (Cartesia). Features auto-scaling, multi-tenant architecture, and webhook integrations.

## Demo

Try the live demo at **https://voice-agent.cameronobrien.dev**

Click to reveal the demo phone number and call to experience the AI voice agent in action. The agent demonstrates natural conversation, information collection, and real-time responses.

## Tech Stack

- **Node.js + Express** - Web server and API
- **WebSockets (ws)** - Real-time bidirectional communication
- **Deepgram SDK** - Speech-to-text transcription
- **Groq SDK** - Fast LLM inference (Llama models)
- **Google Gemini AI** - Alternative LLM with auto-fallback
- **Cartesia** - Ultra-low latency text-to-speech
- **Neon PostgreSQL** - Multi-tenant data storage
- **Fly.io** - Serverless deployment with auto-scaling
- **Docker** - Containerized deployment

## Features

- **Real-Time Voice Conversations** - Low-latency voice AI interactions
- **Multi-Tenant Architecture** - Support multiple clients with isolated data
- **Auto-Scaling** - Fly.io machines spin up on demand (0→1 scaling)
- **AI Provider Auto-Switching** - Automatic fallback between Groq and Gemini
- **Speech-to-Text** - Deepgram real-time transcription
- **Text-to-Speech** - Cartesia ultra-fast voice synthesis
- **WebSocket Streaming** - Real-time audio streaming
- **Webhook Integration** - Push call data to external systems
- **Metrics API** - Track usage and performance
- **Custom Prompts** - Configurable AI agent personalities
- **Database Persistence** - Store conversations and metadata

## API Endpoints

### Voice
- `POST /voice/stream` - WebSocket endpoint for voice streaming
- `POST /voice/conversation` - Start new voice conversation

### Metrics
- `GET /metrics` - Get platform usage metrics (requires API key)
- `GET /health` - Health check endpoint

### Webhooks
- Outbound webhook to `WEBHOOK_URL` on call completion

## Setup

### Prerequisites
- Node.js 18+
- Fly.io account and CLI installed
- API keys for:
  - Deepgram (speech-to-text)
  - Groq (LLM)
  - Google Gemini (LLM backup)
  - Cartesia (text-to-speech)
- Neon database

### Local Development

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in all API keys

# Run database extensions
psql $DATABASE_URL < db-schema-extensions.sql

# Start development server
npm run dev
```

Server runs on [http://localhost:8080](http://localhost:8080)

## Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with hot reload
- `npm test` - Run tests (not yet implemented)

## Environment Variables

See `.env.example` for required configuration:

### Server
- `PORT` - Server port (default: 8080)
- `NODE_ENV` - Environment (development/production)

### Fly.io Configuration (Required)
- `FLY_STREAM_URL` - Your WebSocket stream URL (e.g., `wss://your-app.fly.dev/stream`)
- `CORS_ORIGINS` - Comma-separated list of allowed origins for admin API

### Database
- `DATABASE_URL` - Neon PostgreSQL connection string

### Voice AI APIs
- `DEEPGRAM_API_KEY` - Deepgram API key for speech-to-text
- `GROQ_API_KEY` - Groq API key for LLM (primary)
- `GOOGLE_API_KEY` - Google Gemini API key (fallback)
- `CARTESIA_API_KEY` - Cartesia API key for text-to-speech

### Webhooks
- `WEBHOOK_URL` - External webhook URL for call data
- `WEBHOOK_SECRET` - Secret for webhook verification

### Admin API
- `ADMIN_API_KEY` - API key for accessing admin endpoints

### Optional
- `LLM_PROVIDER` - Force LLM provider (auto, groq, or gemini)
- `BLOCKED_NUMBER` - Phone number to block from connecting

## Project Structure

```
├── src/                      # Source code
│   ├── api/                  # API routes
│   ├── db/                   # Database client and queries
│   ├── prompts/              # AI agent prompts
│   ├── services/             # Core services
│   │   ├── deepgram.js       # Speech-to-text
│   │   ├── groq.js           # Groq LLM
│   │   ├── gemini.js         # Gemini LLM
│   │   └── cartesia.js       # Text-to-speech
│   ├── utils/                # Utilities
│   └── server.js             # Express server
├── scripts/                  # Deployment scripts
├── public/                   # Static assets
├── db-schema-extensions.sql  # Database setup
├── Dockerfile                # Container definition
├── fly.toml                  # Fly.io configuration
└── package.json              # Dependencies
```

## Deployment to Fly.io

### Initial Deployment

```bash
# Install Fly.io CLI
curl -L https://fly.io/install.sh | sh

# Login to Fly.io
fly auth login

# Launch app (creates fly.toml with your app name)
fly launch

# Set secrets (do NOT put in fly.toml)
fly secrets set DATABASE_URL="postgresql://..."
fly secrets set DEEPGRAM_API_KEY="..."
fly secrets set GROQ_API_KEY="..."
fly secrets set GOOGLE_API_KEY="..."
fly secrets set CARTESIA_API_KEY="..."
fly secrets set FLY_STREAM_URL="wss://your-app-name.fly.dev/stream"
fly secrets set CORS_ORIGINS="https://your-domain.com"
fly secrets set ADMIN_API_KEY="your-random-32-char-hex"
fly secrets set WEBHOOK_URL="https://your-domain.com/api/webhooks/call-data"
fly secrets set WEBHOOK_SECRET="your-webhook-secret"

# Deploy
fly deploy
```

### Customization for Your Deployment

When deploying your own instance, you'll need to customize:

1. **App Name**: Run `fly launch` to generate your own app name, or edit `fly.toml`:
   ```toml
   app = 'your-app-name'
   ```

2. **Stream URL**: Set `FLY_STREAM_URL` to your app's WebSocket endpoint:
   ```bash
   fly secrets set FLY_STREAM_URL="wss://your-app-name.fly.dev/stream"
   ```

3. **CORS Origins**: Set allowed origins for your admin dashboard:
   ```bash
   fly secrets set CORS_ORIGINS="https://your-admin-domain.com,https://your-app.com"
   ```

4. **Twilio Webhook**: Point your Twilio number's webhook to:
   ```
   https://your-app-name.fly.dev/api/twilio/router
   ```

### Updating Deployment

```bash
# Deploy new version
fly deploy

# View logs
fly logs

# Check status
fly status

# Scale machines
fly scale count 1  # or 0 for auto-scaling
```

## Fly.io Configuration

The `fly.toml` configures:

- **Auto-Scaling**: Machines spin down to 0 when idle, start on first request
- **Region**: `sjc` (San Jose, California) - adjust for your users
- **Resources**: 1GB RAM, 1 shared CPU
- **HTTPS**: Force HTTPS on all requests
- **Port**: Internal port 8080

## Multi-Tenant Architecture

Each client/tenant has:
- Isolated database records
- Custom AI prompts
- Separate webhook endpoints
- Individual usage tracking

Tenant identification via:
- API key authentication
- Request headers
- Database tenant_id column

## Voice AI Flow

1. **Client connects** via WebSocket
2. **Audio streaming** - Client sends audio chunks
3. **Speech-to-Text** - Deepgram transcribes in real-time
4. **AI Processing** - Groq/Gemini generates response
5. **Text-to-Speech** - Cartesia synthesizes voice
6. **Audio streaming** - Server sends audio chunks back
7. **Webhook** - Call data posted to WEBHOOK_URL

## AI Provider Auto-Switching

Set `LLM_PROVIDER=auto` to automatically failover:
1. Try Groq (fastest, lowest latency)
2. If Groq fails/rate-limited → switch to Gemini
3. Log provider switches for monitoring

## Database Schema

Run database extensions:

```bash
psql $DATABASE_URL < db-schema-extensions.sql
```

Creates:
- `conversations` table - Store conversation history
- `tenants` table - Multi-tenant configuration
- `call_logs` table - Call metadata and metrics
- Database extensions for performance

## Monitoring

### Health Check

```bash
curl https://your-app.fly.dev/health
```

### Metrics (requires API key)

```bash
curl -H "Authorization: Bearer YOUR_METRICS_API_KEY" \
  https://your-app.fly.dev/metrics
```

Returns:
- Total calls
- Average call duration
- AI provider usage
- Error rates
- Latency metrics

### Fly.io Logs

```bash
fly logs
```

## Webhooks

On call completion, sends POST to `WEBHOOK_URL`:

```json
{
  "call_id": "uuid",
  "duration": 120,
  "transcript": "...",
  "ai_provider": "groq",
  "timestamp": "2025-11-18T12:00:00Z",
  "metadata": { ... }
}
```

Includes HMAC signature for verification using `WEBHOOK_SECRET`.

## Development

### Testing Voice Streaming

Use WebSocket client to test:

```javascript
const ws = new WebSocket('ws://localhost:8080/voice/stream');
ws.onopen = () => {
  // Send audio chunks
  ws.send(audioBuffer);
};
ws.onmessage = (event) => {
  // Receive synthesized audio
  const audio = event.data;
};
```

### Custom Prompts

Edit `src/prompts/` to customize AI agent personality:
- System prompt
- Conversation context
- Response style
- Domain knowledge

## Performance

- **Latency**: <200ms end-to-end (audio in → audio out)
- **Auto-Scaling**: 0→1 in <5 seconds
- **Concurrent Calls**: Unlimited (scales horizontally)
- **Uptime**: 99.9% (Fly.io SLA)

## Security

- **HTTPS Only** - Force HTTPS on all requests
- **API Key Auth** - Metrics endpoint requires authentication
- **Webhook Signing** - HMAC verification for webhooks
- **Database Isolation** - Multi-tenant data separation
- **Secret Management** - Fly.io secrets (not in code)

## Costs

Approximate Fly.io costs (auto-scaling):
- **Idle**: $0/month (0 machines running)
- **Active**: ~$0.02/hour per machine (1GB RAM)
- **Egress**: $0.02/GB

Voice AI API costs:
- **Deepgram**: ~$0.0043/minute
- **Groq**: Free tier available
- **Gemini**: Pay-per-use pricing
- **Cartesia**: ~$0.05/1K characters

## Troubleshooting

### Machine won't start
- Check Fly.io logs: `fly logs`
- Verify all secrets are set: `fly secrets list`
- Check database connectivity

### Audio not streaming
- Verify WebSocket connection
- Check Deepgram API key
- Ensure audio format is compatible

### High latency
- Switch to Groq (faster than Gemini)
- Move Fly.io region closer to users
- Optimize prompts for shorter responses

## License

MIT
