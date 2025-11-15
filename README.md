# Fly Voice Agent

Minimal voice agent project deployed on Fly.io.

## Deployment

This project is configured for deployment on Fly.io using Docker containers.

## Structure

- `index.html` - Main landing page
- `index.js` - Express server
- `package.json` - Node.js package configuration
- `Dockerfile` - Docker container configuration
- `fly.toml` - Fly.io deployment configuration

## Getting Started

### Local Development
```bash
npm install
npm start
```

### Deploy to Fly.io
```bash
fly deploy
```
