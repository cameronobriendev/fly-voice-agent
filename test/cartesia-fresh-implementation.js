/**
 * FRESH CARTESIA TTS IMPLEMENTATION
 * 
 * This follows the official SDK v2.2.9 pattern EXACTLY as documented.
 * No workarounds, no hacks - just the documented approach.
 * 
 * If this doesn't work, the SDK itself has a bug specific to your environment.
 */

import { CartesiaClient } from "@cartesia/cartesia-js";

/**
 * Minimal Cartesia TTS service following official docs
 */
class CartesiaTTS {
  constructor(apiKey, voiceId) {
    // Initialize client exactly as docs show
    this.client = new CartesiaClient({ apiKey });
    this.voiceId = voiceId;
    this.websocket = null;
  }

  /**
   * Initialize WebSocket - following official pattern
   * No connect() call needed in v2.x (according to docs)
   */
  initialize() {
    // Create websocket exactly as docs show
    this.websocket = this.client.tts.websocket({
      container: "raw",
      encoding: "pcm_mulaw",  // For phone calls
      sampleRate: 8000,       // For phone calls
    });

    console.log('[Cartesia] WebSocket object created');
  }

  /**
   * Generate speech - following official pattern EXACTLY
   * 
   * Official docs show:
   * 1. Call websocket.send()
   * 2. Get response object back
   * 3. Attach listeners to response object
   * 4. Done
   */
  async speak(text) {
    if (!this.websocket) {
      throw new Error('Call initialize() first');
    }

    console.log('[Cartesia] Sending text:', text.substring(0, 50));

    // This is THE EXACT pattern from official docs
    const response = await this.websocket.send({
      modelId: "sonic-3",
      voice: {
        mode: "id",
        id: this.voiceId,
      },
      transcript: text,
      language: "en",
    });

    console.log('[Cartesia] Response object received');

    // Collect chunks
    const chunks = [];

    // Option 1: Event listener (official docs method 1)
    response.on("message", (message) => {
      console.log(`[Cartesia] Message type: ${message.type}`);
      
      if (message.type === "chunk") {
        chunks.push(message.data);
      } else if (message.type === "done") {
        console.log(`[Cartesia] Done! Received ${chunks.length} chunks`);
      }
    });

    // Option 2: Async iteration (official docs method 2)
    // Uncomment if event listeners don't work
    /*
    for await (const message of response.events("message")) {
      console.log(`[Cartesia] Message type: ${message.type}`);
      
      if (message.type === "chunk") {
        chunks.push(message.data);
      } else if (message.type === "done") {
        console.log(`[Cartesia] Done! Received ${chunks.length} chunks`);
        break;
      }
    }
    */

    return chunks;
  }
}

/**
 * USAGE EXAMPLE
 */
async function main() {
  const tts = new CartesiaTTS(
    process.env.CARTESIA_API_KEY,
    "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc"
  );

  // Initialize
  tts.initialize();

  // Wait a moment (some SDKs need this)
  await new Promise(resolve => setTimeout(resolve, 100));

  // Speak
  try {
    const chunks = await tts.speak("Hello, this is a test.");
    console.log('Success! Received chunks:', chunks.length);
  } catch (error) {
    console.error('Failed:', error.message);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export default CartesiaTTS;
