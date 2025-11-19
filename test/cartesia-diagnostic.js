/**
 * CARTESIA TTS DIAGNOSTIC VERSION
 * 
 * This will help identify EXACTLY where the failure occurs:
 * 1. SDK initialization
 * 2. WebSocket creation
 * 3. send() call
 * 4. Response object return
 * 5. Event emission
 */

import { CartesiaClient } from "@cartesia/cartesia-js";

class CartesiaTTSDiagnostic {
  constructor(apiKey, voiceId) {
    this.client = new CartesiaClient({ apiKey });
    this.voiceId = voiceId;
    this.websocket = null;
  }

  initialize() {
    console.log('=== DIAGNOSTIC: initialize() START ===');
    console.log('1. Creating websocket object...');
    
    this.websocket = this.client.tts.websocket({
      container: "raw",
      encoding: "pcm_mulaw",
      sampleRate: 8000,
    });

    console.log('2. Websocket object created');
    console.log('   Type:', typeof this.websocket);
    console.log('   Has send:', typeof this.websocket.send);
    console.log('=== DIAGNOSTIC: initialize() END ===\n');
  }

  async speak(text) {
    console.log('=== DIAGNOSTIC: speak() START ===');
    console.log('3. Calling websocket.send()...');
    console.log('   Text:', text.substring(0, 30));
    
    const startTime = Date.now();
    
    // Add timeout to detect hangs
    const sendPromise = this.websocket.send({
      modelId: "sonic-3",
      voice: { mode: "id", id: this.voiceId },
      transcript: text,
      language: "en",
    });

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('TIMEOUT: send() hung for 10 seconds')), 10000);
    });

    let response;
    try {
      response = await Promise.race([sendPromise, timeoutPromise]);
      const elapsed = Date.now() - startTime;
      console.log(`4. send() returned after ${elapsed}ms ✅`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.log(`4. send() FAILED after ${elapsed}ms ❌`);
      console.log('   Error:', error.message);
      throw error;
    }

    console.log('5. Response object received:');
    console.log('   Type:', typeof response);
    console.log('   Has on:', typeof response.on);
    console.log('   Has events:', typeof response.events);
    console.log('   Keys:', Object.keys(response));

    // Try to attach listeners
    console.log('6. Attaching event listeners...');
    
    let messageCount = 0;
    let chunkCount = 0;
    let firstMessageTime = null;

    response.on("message", (message) => {
      if (!firstMessageTime) {
        firstMessageTime = Date.now();
        const latency = firstMessageTime - startTime;
        console.log(`7. FIRST MESSAGE received after ${latency}ms ✅`);
      }
      
      messageCount++;
      console.log(`   Message #${messageCount}: type="${message.type}"`);
      
      if (message.type === "chunk") {
        chunkCount++;
      } else if (message.type === "done") {
        console.log(`8. DONE received. Total: ${chunkCount} chunks, ${messageCount} messages ✅`);
      } else if (message.type === "error") {
        console.log(`8. ERROR received: ${message.message} ❌`);
      }
    });

    // Add error handler
    response.on("error", (error) => {
      console.log('   Response error:', error);
    });

    console.log('9. Waiting for messages...');

    // Wait for completion or timeout
    return new Promise((resolve, reject) => {
      const maxWait = setTimeout(() => {
        if (messageCount === 0) {
          console.log('10. TIMEOUT: No messages received ❌');
          reject(new Error('No messages received after 10s'));
        } else {
          console.log('10. TIMEOUT: Messages stopped coming ⚠️');
          resolve(chunkCount);
        }
      }, 10000);

      response.on("message", (message) => {
        if (message.type === "done") {
          clearTimeout(maxWait);
          console.log('10. SUCCESS: Completed normally ✅');
          resolve(chunkCount);
        } else if (message.type === "error") {
          clearTimeout(maxWait);
          reject(new Error(message.message));
        }
      });
    });
  }
}

/**
 * RUN DIAGNOSTIC TEST
 */
async function runDiagnostics() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  CARTESIA TTS DIAGNOSTIC TEST         ║');
  console.log('╚════════════════════════════════════════╝\n');

  const tts = new CartesiaTTSDiagnostic(
    process.env.CARTESIA_API_KEY,
    "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
  );

  console.log('Environment Info:');
  console.log('  Node version:', process.version);
  console.log('  Platform:', process.platform);
  console.log('  Arch:', process.arch);
  console.log('  SDK:', '@cartesia/cartesia-js');
  console.log('');

  try {
    tts.initialize();
    
    console.log('Waiting 500ms before first send()...\n');
    await new Promise(r => setTimeout(r, 500));
    
    await tts.speak("This is a diagnostic test of the Cartesia TTS system.");
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  DIAGNOSTIC RESULT: SUCCESS ✅         ║');
    console.log('╚════════════════════════════════════════╝');
  } catch (error) {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  DIAGNOSTIC RESULT: FAILURE ❌         ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('\nFailure Point:', error.message);
    console.log('Stack:', error.stack);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDiagnostics();
}

export default CartesiaTTSDiagnostic;
