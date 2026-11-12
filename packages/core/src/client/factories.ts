import { openIdbBackend } from './idb-backend';
import { createMemoryBackend } from './memory-backend';
import { createRepository, type CuenuRepository } from './repo';
import { dbNameFor } from './util';

export interface MemoryRepositoryOptions {
  deviceId?: string;
  /** 同期テスト用。サーバー接続ありとして初回取り込み未完了から始める */
  connected?: boolean;
  name?: string;
}

/** インメモリ実装。リロードで消える。UI 開発・テスト用 */
export function createMemoryRepository(options: MemoryRepositoryOptions = {}): CuenuRepository {
  return createRepository(createMemoryBackend(options.name ?? 'cuenu:memory'), {
    deviceId: options.deviceId,
    localOnly: !options.connected,
    channelName: null,
  });
}

export interface IdbRepositoryOptions {
  /** 接続先サーバーURL。null/未指定は未接続環境（DB名 cuenu:local） */
  serverUrl?: string | null;
  /** DB 名を明示（desktop の envKey 等）。未指定なら dbNameFor(serverUrl) */
  dbName?: string;
  deviceId?: string;
  /** navigator.storage.persist() を要求する（既定 true） */
  requestPersistence?: boolean;
  /** 別タブで新しいスキーマへ更新された。このタブは再読み込みが必要 */
  onVersionChange?: () => void;
  onBlocked?: () => void;
}

export interface IdbRepository extends CuenuRepository {
  /** 永続ストレージが許可されたか（未対応・未要求は null） */
  readonly persisted: boolean | null;
}

/**
 * IndexedDB 実装。DB は接続先ごとに分離（cuenu:<hash(serverUrl)> / cuenu:local）するため、
 * 接続先を変えたら新しいリポジトリを作り直す（前環境の未送信は前環境の DB に残り、別環境へ送られない）。
 */
export async function createIdbRepository(options: IdbRepositoryOptions = {}): Promise<IdbRepository> {
  const name = options.dbName ?? dbNameFor(options.serverUrl);
  const backend = await openIdbBackend(name, {
    onVersionChange: options.onVersionChange,
    onBlocked: options.onBlocked,
  });
  let persisted: boolean | null = null;
  if (options.requestPersistence !== false) {
    try {
      const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (storage?.persist) persisted = (await storage.persisted?.()) || (await storage.persist());
    } catch {
      persisted = null;
    }
  }
  const repo = createRepository(backend, { deviceId: options.deviceId, localOnly: !options.serverUrl });
  await repo.ready();
  return Object.assign(repo, { persisted });
}
