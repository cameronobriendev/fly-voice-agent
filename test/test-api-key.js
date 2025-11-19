/**
 * Test if CARTESIA_API_KEY is valid using REST API
 * This doesn't use WebSocket, so network issues won't affect it
 */

import { CartesiaClient } from "@cartesia/cartesia-js";

async function testAPIKey() {
  console.log('Testing CARTESIA_API_KEY validity...\n');

  const apiKey = process.env.CARTESIA_API_KEY;

  if (!apiKey) {
    console.log('❌ CARTESIA_API_KEY not set in environment');
    console.log('   Set it in ~/.zshrc or .env file');
    process.exit(1);
  }

  console.log(`✅ API Key found: ${apiKey.substring(0, 10)}...`);
  console.log(`   Length: ${apiKey.length} characters\n`);

  const client = new CartesiaClient({ apiKey });

  try {
    console.log('Attempting REST API call to validate key...');

    // Use bytes() method which is a simple REST API call
    const stream = await client.tts.bytes({
      modelId: "sonic-3",
      transcript: "Test.",
      voice: {
        mode: "id",
        id: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
      },
      language: "en",
      outputFormat: {
        container: "raw",
        sampleRate: 8000,
        encoding: "pcm_mulaw"
      }
    });

    // Read first chunk to verify it works
    const reader = stream[Symbol.asyncIterator]();
    const first = await reader.next();

    if (!first.done) {
      console.log('✅ API KEY IS VALID!');
      console.log('   REST API call succeeded');
      console.log('   Received audio data\n');
      console.log('This means the problem is specifically with WebSocket connections, not the API key.');
      process.exit(0);
    }

  } catch (error) {
    console.log('❌ API KEY IS INVALID OR API ERROR');
    console.log(`   Error: ${error.message}`);

    if (error.statusCode) {
      console.log(`   Status: ${error.statusCode}`);
    }

    if (error.statusCode === 401) {
      console.log('\n→ This means your API key is invalid or expired');
      console.log('  Get a new key from: https://play.cartesia.ai/');
    }

    process.exit(1);
  }
}

testAPIKey();
