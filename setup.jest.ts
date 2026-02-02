// jest.setup.ts
import { TextEncoder, TextDecoder } from 'util';
import { BroadcastChannel } from 'worker_threads';
import 'whatwg-fetch';

Object.assign(global, { TextEncoder, TextDecoder, BroadcastChannel });
