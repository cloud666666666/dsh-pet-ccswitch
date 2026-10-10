/**
 * pic.mjs —— 气泡配图的解析（宿主 `/pic/...` 路由的唯一真相）
 *
 * 桌宠拼配图 URL 的规则是**写死的**（见 shared-core 的 memeImageUrl）：
 *
 *     <base>/pic/memes/<encodeURIComponent(名字)>.png
 *
 * 也就是**所有**配图都从 `memes/` 这条通道走，名字整体被编码，末尾还会被硬加一个 `.png`。
 * 于是这个函数拿到的 rel 长这样：
 *
 *     memes/asset/img_res/food/100010032.gif.png      ← 物品图标（名字自带 .gif）
 *     memes/asset/img_res/toy/t0002.png.png           ← 玩具图标（名字自带 .png）
 *     memes/album/g_anhui1.webp.png                   ← 相簿照片
 *     memes/fish/2.png                                ← 养的鱼
 *     memes/achv/travel.png                           ← 成就徽章
 *     memes/portrait.png                              ← 主人自己的头像
 *     memes/先养着吧.png                               ← 表情包（名字**不带**扩展名）
 *
 * 所以这里先把 `memes/` 与末尾那个 `.png` 剥掉，再按名字前缀分派。
 * 两个坑（都踩过，都有用例盯着）：
 *   1. **末尾那个 .png 是桌宠加的，不代表真实扩展名** —— 物品图标有 .gif/.png/.svg 三种，
 *      剥完名字后必须原样保留名字里自带的扩展名（早先多剥一层，玩具/工作图标全 404）；
 *   2. **表情包的名字里本来就没有扩展名**（配置的键 = assets/memes 下的文件名去掉 .png），
 *      同一个剥离动作会把它的扩展名也吃掉，导致 27 张表情包全 404 —— 分派到表情包时补回来。
 *   3. 目录名也别自己拼：原版素材目录有拼错的（nums 实际叫 muns），
 *      物品图标的路径一律取自物品表里的 url（见 goods.mjs 的 iconOf）。
 *
 * 素材来源有两处：随包的 assets/（表情包、光标）与用户本机的 qqpet 素材目录（相簿/鱼/图标，
 * 版权原因不随包分发，靠 assetsFrom 指过去）。取不到就返回 null —— 气泡宁可不贴图，
 * 也不要贴一张破图。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 名字前缀 → 素材目录里的真实相对路径（返回 null 表示"这个名字不归我管"） */
function fromQqpet(root, name) {
  if (name.startsWith('album/')) {
    return path.join(root, 'album', path.basename(name.slice('album/'.length))) + '.webp'; // 磁盘上是 .webp
  }
  if (name.startsWith('asset/')) {
    // 路径直接取自物品表里的 url（`./pet/img_res/food/100010032.gif` → `img_res/food/100010032.gif`）。
    // 防穿越：只允许普通路径段。
    const rest = name.slice('asset/'.length).split('/').filter((x) => x && x !== '.' && x !== '..');
    return rest.length >= 2 ? path.join(root, ...rest) : null;
  }
  if (name.startsWith('achv/')) {
    return path.join(root, 'achievement', path.basename(name.slice('achv/'.length)) + '.svg'); // 原版只有 3 张 svg
  }
  if (name.startsWith('fish/')) {
    const id = path.basename(name.slice('fish/'.length)).replace(/\.png$/i, ''); // 名字里的 .png 已被剥掉，磁盘上就是 <avator>.png
    return path.join(root, 'fishing', 'res', 'fish', id + '.png');
  }
  return undefined; // 不是 qqpet 的名字
}

/** 第一个真实存在的文件；都不在就返回 null */
function firstExisting(candidates) {
  for (const f of candidates) {
    if (!f) continue;
    try {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
    } catch {
      /* 权限/竞态：当它不在 */
    }
  }
  return null;
}

/**
 * 造一个解析器。宿主传自己的素材目录与配置读取；
 * 测试传临时目录，不用起服务也能把这份矩阵验一遍。
 */
export function createPicResolver({ assetsDir, getSettings }) {
  return function resolvePic(rel) {
    let clean = rel;
    try {
      clean = decodeURIComponent(rel); // 畸形转义按原样处理（调用方已拦一次，这里兜底）
    } catch {
      /* ignore */
    }
    // 表情包的名字里可能带 `/`（我们借这条通道传 asset/xxx、album/xxx），所以捕获组要留斜杠
    const m = /^memes\/(.*?)(?:\.png)?$/i.exec(clean);
    if (!m) return firstExisting([path.join(assetsDir, 'pic', path.basename(clean))]); // 光标等随包素材
    const name = m[1];
    if (!name) return null;

    const cfg = (getSettings && getSettings()) || {};
    const root = String(cfg.assetsFrom?.value || '').trim();
    if (root) {
      const hit = fromQqpet(root, name);
      if (hit !== undefined) return firstExisting([hit]);
    }

    // 主人自己的图（配置项 portrait）：**不是**原版那 6 张企鹅立绘 ——
    // 那是腾讯的 QQ 宠物，跟这只宠物不是同一个角色，贴上去等于串角色（见 README）
    if (name === 'portrait') {
      const mine = String(cfg.portrait?.value || '').trim();
      return firstExisting([mine || null]);
    }

    // 表情包：名字不带扩展名，桌宠在 URL 末尾加的那个 .png 已经被剥掉了，补回来再找。
    // 找不到就是真没有（配置里已经剔除过一轮），返回 null 让宿主干脆地 404。
    const base = path.basename(name);
    return firstExisting([path.join(assetsDir, 'memes', base + '.png'), path.join(assetsDir, 'pic', base)]);
  };
}
