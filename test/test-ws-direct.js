/**
 * Test WebSocket connection DIRECTLY to Cartesia
 * Bypasses SDK to isolate connection issue
 */

import WebSocket from 'ws';

async function testDirectWebSocket() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  DIRECT WEBSOCKET CONNECTION TEST     ║');
  console.log('╚════════════════════════════════════════╝\n');

  const apiKey = process.env.CARTESIA_API_KEY;

  if (!apiKey) {
    console.log('❌ CARTESIA_API_KEY not set');
    console.log('   This test requires the API key from Fly.io secrets\n');
    console.log('Run: flyctl secrets list -a fly-voice-agent-red-darkness-2650');
    process.exit(1);
  }

  console.log(`API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)}`);
  console.log(`Length: ${apiKey.length} characters\n`);

  // Build WebSocket URL exactly as SDK does
  const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${apiKey}&cartesia_version=2025-04-16`;

  console.log('Connecting to:', wsUrl.replace(apiKey, '***API_KEY***'));
  console.log('');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let connected = false;

    // Timeout if no connection after 5 seconds
    const timeout = setTimeout(() => {
      if (!connected) {
        console.log('❌ TIMEOUT: No connection after 5 seconds');
        ws.close();
        reject(new Error('Connection timeout'));
      }
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      connected = true;
      console.log('✅ WebSocket OPEN event fired');
      console.log('   Connection successful!\n');

      // Send a test TTS request
      const request = {
        model_id: 'sonic-3',
        voice: {
          mode: 'id',
          id: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc'
        },
        transcript: 'Test',
        language: 'en',
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000
        }
      };

      console.log('Sending TTS request...');
      ws.send(JSON.stringify(request));
    });

    ws.on('message', (data) => {
      console.log('✅ MESSAGE received');
      console.log(`   Size: ${data.length} bytes`);
      console.log(`   Type: ${typeof data}`);

      // Parse if JSON
      try {
        const parsed = JSON.parse(data.toString());
        console.log('   JSON:', JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log('   Binary data (not JSON)');
      }

      console.log('\n✅ SUCCESS: WebSocket works perfectly!');
      ws.close();
      resolve();
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log('❌ WebSocket ERROR event');
      console.log(`   Message: ${error.message}`);
      console.log(`   Code: ${error.code || 'N/A'}`);
      console.log(`   Stack: ${error.stack}`);
      reject(error);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (!connected) {
        console.log('❌ WebSocket CLOSE event (before open!)');
        console.log(`   Code: ${code}`);
        console.log(`   Reason: ${reason || 'No reason provided'}`);
        console.log('');
        console.log('This means the server rejected the connection immediately.');
        console.log('Possible causes:');
        console.log('  1. Invalid API key');
        console.log('  2. API key not authorized for WebSocket access');
        console.log('  3. WebSocket endpoint changed');
        console.log('  4. Firewall/proxy blocking connection');
        reject(new Error(`WebSocket closed with code ${code}: ${reason}`));
      } else {
        console.log('WebSocket closed normally');
        resolve();
      }
    });
  });
}

testDirectWebSocket()
  .then(() => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  RESULT: WebSocket works! ✅          ║');
    console.log('╚════════════════════════════════════════╝');
    process.exit(0);
  })
  .catch((error) => {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  RESULT: WebSocket failed ❌          ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('\nError:', error.message);
    process.exit(1);
  });
