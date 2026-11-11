/** Campaign soak, chapters 1–5 (see campaign-soak.ts). */
import { describe } from 'vitest';
import { soakScenarios } from './campaign-soak';

describe('campaign soak I–V', () => soakScenarios([1, 2, 3, 4, 5]));
