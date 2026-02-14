/**
 * Integration test for the Foundry Bridge sidecar.
 *
 * 1. Start sidecar
 * 2. Connect mock WebSocket client, send gameReady with mock Fate Core data
 * 3. Send mock chatMessage with Fate roll
 * 4. Connect MCP client, read game://state → verify actors
 * 5. Read game://chat/recent → verify parsed roll
 * 6. Call send_whisper → verify WS client receives whisper message
 * 7. Call search_chat → verify filtering
 * 8. Shutdown cleanly
 */

import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const WS_PORT = parseInt(process.env.WS_PORT ?? '3300', 10);
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3002', 10);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? 'test-token';
const WS_AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? '';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Mock Data ---

const mockActors = {
  'actor-001': {
    id: 'actor-001',
    name: 'Zara the Bold',
    type: 'character',
    img: '',
    aspects: [
      { name: 'High Concept', type: 'High Concept', value: 'Fearless Sword-Saint of the Iron Wastes' },
      { name: 'Trouble', type: 'Trouble', value: 'Haunted by the Fall of Ironhaven' },
    ],
    skills: [
      { name: 'Fight', rank: 4 },
      { name: 'Athletics', rank: 3 },
      { name: 'Will', rank: 2 },
    ],
    stunts: [{ name: 'Riposte', description: '+2 to Fight when defending' }],
    tracks: [
      { name: 'Physical Stress', size: 3, value: [false, false, false] },
      { name: 'Mental Stress', size: 2, value: [false, false] },
    ],
    fatePoints: 3,
    refresh: 3,
  },
};

const mockScene = {
  id: 'scene-001',
  name: 'The Ruined Temple',
  active: true,
  width: 4000,
  height: 3000,
  gridSize: 50,
  tokens: [
    { id: 'token-001', name: 'Zara', actorId: 'actor-001', x: 500, y: 300, hidden: false },
  ],
};

const mockChatMessage = {
  id: 'msg-001',
  speakerActorId: 'actor-001',
  speakerAlias: 'Zara the Bold',
  content: 'Rolling Fight against the Shadow Beast',
  type: 0,
  whisper: [],
  rolls: [{ formula: '4dF+4', total: 6, dice: [1, 0, 1, 0] }],
  timestamp: new Date().toISOString(),
};

// --- Test Runner ---

async function runTests(): Promise<void> {
  console.log('\n=== Magi Foundry Bridge Integration Test ===\n');

  // Note: sidecar must be started externally before running this test:
  //   MCP_AUTH_TOKEN=test-token WS_AUTH_TOKEN=test-ws npm run dev
  // Or run from built output with the same env vars.

  // Step 1: Connect mock WebSocket client
  console.log('1. Connecting WebSocket client...');
  const wsUrl = WS_AUTH_TOKEN
    ? `ws://127.0.0.1:${WS_PORT}?token=${WS_AUTH_TOKEN}`
    : `ws://127.0.0.1:${WS_PORT}`;

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
  });
  assert(ws.readyState === WebSocket.OPEN, 'WebSocket connected');

  // Collect messages from sidecar
  const received: unknown[] = [];
  ws.on('message', (data) => {
    try {
      received.push(JSON.parse(data.toString()));
    } catch { /* ignore */ }
  });

  // Step 2: Send gameReady
  console.log('\n2. Sending gameReady...');
  ws.send(JSON.stringify({
    type: 'gameReady',
    actors: mockActors,
    scene: mockScene,
    combat: null,
    chatHistory: [],
  }));
  await sleep(500);

  // Step 3: Send chatMessage with Fate roll
  console.log('\n3. Sending chatMessage with Fate roll...');
  ws.send(JSON.stringify({
    type: 'chatMessage',
    message: mockChatMessage,
  }));
  await sleep(500);

  // Step 4: Connect MCP client and read resources
  console.log('\n4. Connecting MCP client...');
  const sseUrl = new URL(`http://127.0.0.1:${MCP_PORT}/sse`);
  sseUrl.searchParams.set('token', MCP_AUTH_TOKEN);
  const transport = new SSEClientTransport(sseUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}` },
    },
  });
  const mcpClient = new Client(
    { name: 'integration-test', version: '0.1.0' },
    { capabilities: {} }
  );
  await mcpClient.connect(transport);
  assert(true, 'MCP client connected');

  // Read game://state
  console.log('\n5. Reading game://state...');
  const stateResult = await mcpClient.readResource({ uri: 'game://state' });
  const stateText = (stateResult.contents?.[0] as { text?: string })?.text ?? '';
  const state = JSON.parse(stateText);
  assert(state.actors?.['actor-001']?.name === 'Zara the Bold', 'Actor found in game state');
  assert(state.scene?.name === 'The Ruined Temple', 'Scene found in game state');

  // Read game://chat/recent
  console.log('\n6. Reading game://chat/recent...');
  const chatResult = await mcpClient.readResource({ uri: 'game://chat/recent' });
  const chatText = (chatResult.contents?.[0] as { text?: string })?.text ?? '';
  const chatMessages = JSON.parse(chatText);
  assert(chatMessages.length > 0, 'Chat messages present');
  const lastMsg = chatMessages[chatMessages.length - 1];
  assert(lastMsg.parsedRoll !== null, 'Parsed roll present');
  assert(lastMsg.parsedRoll?.total === 6, 'Roll total is 6');
  assert(lastMsg.parsedRoll?.ladder === 'Fantastic', '+6 = Fantastic on Fate ladder');

  // Step 6: Call send_whisper tool
  console.log('\n7. Calling send_whisper tool...');
  const tools = await mcpClient.listTools();
  const whisperTool = tools.tools?.find((t) => t.name === 'send_whisper');
  assert(whisperTool !== undefined, 'send_whisper tool exists');

  if (whisperTool) {
    await mcpClient.callTool({
      name: 'send_whisper',
      arguments: { content: 'Test whisper from integration test', title: 'Test' },
    });
    await sleep(200);
    const whisperMsg = received.find((m: unknown) => (m as { type: string }).type === 'whisper');
    assert(whisperMsg !== undefined, 'Whisper received by WebSocket client');
  }

  // Step 7: Call search_chat tool
  console.log('\n8. Calling search_chat tool...');
  const searchResult = await mcpClient.callTool({
    name: 'search_chat',
    arguments: { query: 'Shadow Beast', limit: 10 },
  });
  const searchContent = (searchResult.content as Array<{ text: string }>)[0]?.text ?? '[]';
  const searchMatches = JSON.parse(searchContent);
  assert(searchMatches.length > 0, 'search_chat found matching messages');

  // Step 8: Cleanup
  console.log('\n9. Cleaning up...');
  await transport.close();
  ws.close();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
