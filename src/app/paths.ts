import { join } from 'node:path';

/** 运行时数据目录：数据库、密钥、配置、浏览器资料。整个目录都不入库 */
export interface RuntimePaths {
  dir: string;
  db: string;
  key: string;
  settings: string;
  lock: string;
  browserProfiles: string;
  uiProfile: string;
  license: string;
}

export function runtimePaths(dir: string): RuntimePaths {
  return {
    dir,
    db: join(dir, 'data.sqlite'),
    key: join(dir, 'secret.key'),
    settings: join(dir, 'settings.json'),
    lock: join(dir, 'app.lock'),
    browserProfiles: join(dir, 'browser-profile'),
    uiProfile: join(dir, 'ui-profile'),
    license: join(dir, 'license.json'),
  };
}
