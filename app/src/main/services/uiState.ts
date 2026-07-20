import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import { UiStateSchema, type UiState } from '../../shared/ui-types';

/**
 * Per-project UI state (M1.5 EU1): one JSON blob under the `ui.state` key of
 * the project DB's `settings` table. All fields optional — a partial or
 * corrupt payload degrades to "no stored state" rather than failing.
 */
const SETTINGS_KEY = 'ui.state';

export class UiStateService {
  constructor(private readonly db: DatabaseSync) {}

  get(): UiState {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) {
      return {};
    }
    try {
      return Value.Decode(UiStateSchema, JSON.parse(row.value));
    } catch {
      // Corrupt or shape-incompatible blob — start fresh, don't crash the UI.
      return {};
    }
  }

  set(state: UiState): UiState {
    const validated = Value.Decode(UiStateSchema, state);
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(SETTINGS_KEY, JSON.stringify(validated));
    return validated;
  }
}
