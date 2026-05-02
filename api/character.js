// Has Epix Armory — Vercel Serverless API
// Full port of fetch_character.py — returns identical JSON structure.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────────────────────
const CLIENT_ID     = '5f3738add0b24ac98330ae54297e0ebf';
const CLIENT_SECRET = '1xl9pT7JdMwd64hDHsc7KsHmbjugTpGs';
const REALM_SLUG    = 'thunderstrike';
const REGION        = 'eu';
const PROFILE_NS    = 'profile-classicann-eu';
const STATIC_NS     = 'static-classic-eu';
const STATIC_MEDIA_NS = 'static-classicann-eu';
const LOCALE        = 'en_GB';
const BASE_URL      = `https://${REGION}.api.blizzard.com`;
const TOKEN_URL     = `https://${REGION}.battle.net/oauth/token`;

const CLASS_NAMES = {1:'Warrior',2:'Paladin',3:'Hunter',4:'Rogue',5:'Priest',7:'Shaman',8:'Mage',9:'Warlock',11:'Druid'};
const RACE_NAMES  = {1:'Human',2:'Orc',3:'Dwarf',4:'Night Elf',5:'Undead',6:'Tauren',7:'Gnome',8:'Troll',10:'Blood Elf',11:'Draenei'};
const CLASS_COLORS = {1:'#C69B3A',2:'#F48CBA',3:'#AAD372',4:'#FFF468',5:'#FFFFFF',7:'#0070DE',8:'#3FC7EB',9:'#8788EE',11:'#FF7C0A'};
const CLASS_TREES = {
  1:['Arms','Fury','Protection'],2:['Holy','Protection','Retribution'],
  3:['Beast Mastery','Marksmanship','Survival'],4:['Assassination','Combat','Subtlety'],
  5:['Discipline','Holy','Shadow'],7:['Elemental','Enhancement','Restoration'],
  8:['Arcane','Fire','Frost'],9:['Affliction','Demonology','Destruction'],
  11:['Balance','Feral Combat','Restoration'],
};
const CLASS_ICON_NAMES = {
  1:'classicon_warrior',2:'classicon_paladin',3:'classicon_hunter',
  4:'classicon_rogue',5:'classicon_priest',7:'classicon_shaman',
  8:'classicon_mage',9:'classicon_warlock',11:'classicon_druid',
};
const QUALITY_COLORS = {
  POOR:'#9d9d9d',COMMON:'#ffffff',UNCOMMON:'#1eff00',
  RARE:'#0070dd',EPIC:'#a335ee',LEGENDARY:'#ff8000',
  ARTIFACT:'#e6cc80',HEIRLOOM:'#00ccff',
};
const SLOT_LABELS = {
  HEAD:'Head',NECK:'Neck',SHOULDER:'Shoulders',BACK:'Back',CHEST:'Chest',
  SHIRT:'Shirt',TABARD:'Tabard',WRIST:'Wrists',HANDS:'Hands',WAIST:'Waist',
  LEGS:'Legs',FEET:'Feet',FINGER_1:'Finger 1',FINGER_2:'Finger 2',
  TRINKET_1:'Trinket 1',TRINKET_2:'Trinket 2',
  MAIN_HAND:'Main Hand',OFF_HAND:'Off Hand',RANGED:'Ranged/Relic',AMMO:'Ammo',
};
const SLOT_ORDER = [
  'HEAD','NECK','SHOULDER','BACK','CHEST','SHIRT','TABARD',
  'WRIST','HANDS','WAIST','LEGS','FEET',
  'FINGER_1','FINGER_2','TRINKET_1','TRINKET_2',
  'MAIN_HAND','OFF_HAND','RANGED',
];

// ── In-process caches (survive warm invocations) ───────────────────────────────
let _token = null;
let _tokenExpires = 0;
const _iconDataCache = new Map();   // icon_name -> data URI
const _itemIconCache = new Map();   // item_id   -> icon_name
const _itemSocketCache = new Map(); // item_id   -> socket list
const _itemLevelCache = new Map();  // item_id   -> ilvl int
let _talentPositions = null;

// ── Talent positions (bundled JSON) ───────────────────────────────────────────
function loadTalentPositions() {
  if (_talentPositions) return _talentPositions;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'talent_positions.json'), 'utf8');
    _talentPositions = JSON.parse(raw);
  } catch {
    _talentPositions = { by_spell_id: {}, by_class_id: {} };
  }
  return _talentPositions;
}

// ── OAuth token ────────────────────────────────────────────────────────────────
async function getToken() {
  const now = Date.now() / 1000;
  if (_token && _tokenExpires > now + 60) return _token;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000),
  });
  const data = await resp.json();
  _token = data.access_token;
  _tokenExpires = now + (data.expires_in || 86400);
  return _token;
}

// ── Blizzard API helper ────────────────────────────────────────────────────────
async function wowApi(urlPath, namespace, token, extra = {}) {
  const params = new URLSearchParams({ namespace, locale: LOCALE, ...extra });
  try {
    const resp = await fetch(`${BASE_URL}${urlPath}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch { return null; }
}

// ── Image fetching ─────────────────────────────────────────────────────────────
async function fetchAsBase64(url, mimeType = 'image/jpeg') {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    const ct = resp.headers.get('content-type') || mimeType;
    return `data:${ct.split(';')[0].trim()};base64,${b64}`;
  } catch { return null; }
}

async function fetchIconDataUri(iconName, size = 'large') {
  if (!iconName) return null;
  if (_iconDataCache.has(iconName)) return _iconDataCache.get(iconName);
  const uri = await fetchAsBase64(`https://wow.zamimg.com/images/wow/icons/${size}/${iconName}.jpg`);
  if (uri) _iconDataCache.set(iconName, uri);
  return uri;
}

async function getItemIconName(itemId, token) {
  if (_itemIconCache.has(itemId)) return _itemIconCache.get(itemId);
  const data = await wowApi(`/data/wow/media/item/${itemId}`, STATIC_MEDIA_NS, token);
  try {
    const url = data?.assets?.[0]?.value || '';
    const name = url.split('/').pop()?.replace(/\.jpg$/i,'').toLowerCase() || null;
    if (name) _itemIconCache.set(itemId, name);
    return name;
  } catch { return null; }
}

async function fetchItemStaticData(itemId, token) {
  const socCached = _itemSocketCache.has(itemId);
  const lvlCached = _itemLevelCache.has(itemId);
  if (socCached && lvlCached) {
    return [_itemSocketCache.get(itemId), _itemLevelCache.get(itemId)];
  }
  try {
    const data = await wowApi(`/data/wow/item/${itemId}`, STATIC_NS, token);
    const preview = data?.preview_item || {};
    const rawSocks = preview.sockets || [];
    const sockets = rawSocks.map(s => ({ socket_type: s?.socket_type?.name || 'Socket' }));
    let ilvl = data?.level ?? preview?.item_level?.value ?? null;
    if (ilvl) ilvl = parseInt(ilvl);
    if (!socCached) _itemSocketCache.set(itemId, sockets);
    if (!lvlCached && ilvl) _itemLevelCache.set(itemId, ilvl);
    return [_itemSocketCache.get(itemId) || sockets, _itemLevelCache.get(itemId) || ilvl];
  } catch {
    if (!socCached) _itemSocketCache.set(itemId, []);
    return [_itemSocketCache.get(itemId) || [], _itemLevelCache.get(itemId) || null];
  }
}

// ── Item stats extraction ──────────────────────────────────────────────────────
function extractItemStats(rawItem) {
  const result = {};
  const lvl = rawItem.level;
  if (typeof lvl === 'object' && lvl?.value) result.item_level = lvl.value;
  else if (typeof lvl === 'number') result.item_level = lvl;

  const binding = rawItem.binding?.name;
  if (binding) result.binding = binding;

  const subclass = rawItem.item_subclass?.name || '';
  const invType  = rawItem.inventory_type?.name || '';
  const subLower = subclass.toLowerCase();
  if (subclass && invType && subLower !== 'misc' && subLower !== 'miscellaneous') {
    result.item_type = `${subclass} \u2022 ${invType}`;
  } else if (invType) {
    result.item_type = invType;
  }

  if (rawItem.armor?.value) result.armor = rawItem.armor.value;

  const stats = (rawItem.stats || []).map(s => {
    const display = s?.display?.display_string || '';
    if (!display) return null;
    let is_equip = s.is_equip_bonus || false;
    const color = s?.display?.color || {};
    if (!is_equip && color.g === 255 && color.r === 0) is_equip = true;
    return { display, is_equip };
  }).filter(Boolean);
  if (stats.length) result.stats = stats;

  const spells = (rawItem.spells || []).map(sp => sp.description ? { description: sp.description } : null).filter(Boolean);
  if (spells.length) result.spells = spells;

  const enchantments = (rawItem.enchantments || []).map(enc => enc.display_string ? { display: enc.display_string } : null).filter(Boolean);
  if (enchantments.length) result.enchantments = enchantments;

  const sockets = (rawItem.sockets || []).map(sock => ({
    socket_type: sock?.socket_type?.name || 'Socket',
    gem_name: sock?.item?.name || null,
  }));
  if (sockets.length) result.sockets = sockets;

  if (rawItem.durability?.display_string) result.durability = rawItem.durability.display_string;
  const setName = rawItem.set?.item_set?.name;
  if (setName) result.set_name = setName;
  if (rawItem.unique_equipped) result.unique_equipped = rawItem.unique_equipped;

  return result;
}

// ── Main handler ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const name = (req.query.name || '').trim();
  if (!name || !/^[a-zA-Z0-9\-]{2,30}$/.test(name)) {
    return res.status(400).json({ error: 'Invalid character name' });
  }
  const charSlug = name.toLowerCase();

  try {
    const [token] = await Promise.all([getToken(), loadTalentPositions()]);
    if (!token) throw new Error('Failed to obtain API token');

    // Parallel profile calls
    const [profile, equipData, specData, mediaData] = await Promise.all([
      wowApi(`/profile/wow/character/${REALM_SLUG}/${charSlug}`, PROFILE_NS, token),
      wowApi(`/profile/wow/character/${REALM_SLUG}/${charSlug}/equipment`, PROFILE_NS, token),
      wowApi(`/profile/wow/character/${REALM_SLUG}/${charSlug}/specializations`, PROFILE_NS, token),
      wowApi(`/profile/wow/character/${REALM_SLUG}/${charSlug}/character-media`, PROFILE_NS, token),
    ]);

    if (!profile || profile.error) {
      throw new Error(`Character '${name}' not found on Thunderstrike EU`);
    }

    // Class / race / gender
    let classId = null, raceId = null, genderType = 'MALE';
    const classHref = profile.character_class?.key?.href || '';
    const raceHref  = profile.race?.key?.href || '';
    const cm = classHref.match(/playable-class\/(\d+)/);
    const rm = raceHref.match(/playable-race\/(\d+)/);
    if (cm) classId = parseInt(cm[1]);
    if (rm) raceId  = parseInt(rm[1]);
    genderType = profile.gender?.type || 'MALE';

    const className  = CLASS_NAMES[classId]  || `Class ${classId}`  || 'Unknown';
    const raceName   = RACE_NAMES[raceId]    || `Race ${raceId}`    || 'Unknown';
    const classColor = CLASS_COLORS[classId] || '#ffffff';

    // Avatar URL
    let avatarUrl = null;
    for (const asset of (mediaData?.assets || [])) {
      if (asset.key === 'avatar') { avatarUrl = asset.value; break; }
    }

    // Avatar + class icon as base64 (parallel)
    const classIconName = CLASS_ICON_NAMES[classId] || null;
    const [avatarData, classIconData] = await Promise.all([
      avatarUrl ? (async () => {
        const cacheKey = 'avatar_' + (avatarUrl.split('/').pop()?.split('.')[0] || 'avatar');
        if (_iconDataCache.has(cacheKey)) return _iconDataCache.get(cacheKey);
        const uri = await fetchAsBase64(avatarUrl);
        if (uri) _iconDataCache.set(cacheKey, uri);
        return uri;
      })() : Promise.resolve(null),
      classIconName ? fetchIconDataUri(classIconName, 'large') : Promise.resolve(null),
    ]);

    // Equipment — item icons + static data in parallel
    const rawItems = equipData?.equipped_items || [];
    const itemIds = rawItems.map(i => i.item?.id).filter(Boolean);

    const [iconResults, staticResults] = await Promise.all([
      Promise.all(itemIds.map(async id => {
        const name = await getItemIconName(id, token);
        const data = name ? await fetchIconDataUri(name, 'large') : null;
        return [id, name, data];
      })),
      Promise.all(itemIds.map(async id => {
        const [sockets, ilvl] = await fetchItemStaticData(id, token);
        return [id, sockets, ilvl];
      })),
    ]);

    const iconNameMap = {}, iconDataMap = {}, socketMap = {}, levelMap = {};
    for (const [id, iname, idata] of iconResults) {
      iconNameMap[id] = iname;
      iconDataMap[id] = idata;
    }
    for (const [id, sockets, ilvl] of staticResults) {
      socketMap[id] = sockets;
      if (ilvl) levelMap[id] = ilvl;
    }

    const itemsBySlot = {};
    for (const rawItem of rawItems) {
      const slot    = rawItem.slot?.type || 'UNKNOWN';
      const itemId  = rawItem.item?.id;
      const quality = rawItem.quality?.type || 'COMMON';
      if (!itemId) continue;

      const entry = {
        id:           itemId,
        name:         rawItem.name || `Item #${itemId}`,
        quality,
        quality_color: QUALITY_COLORS[quality] || '#ffffff',
        icon:         iconNameMap[itemId] || null,
        icon_data:    iconDataMap[itemId] || null,
        slot,
        slot_label:   SLOT_LABELS[slot] || slot.replace(/_/g,' '),
        ...extractItemStats(rawItem),
      };

      // Fill item_level from static data if missing
      if (!entry.item_level && levelMap[itemId]) entry.item_level = levelMap[itemId];

      // Overlay static socket layout so empty slots show
      const staticSlots = socketMap[itemId] || [];
      if (staticSlots.length > 0) {
        const equippedGems = {};
        for (let i = 0; i < (entry.sockets || []).length; i++) {
          equippedGems[i] = entry.sockets[i].gem_name;
        }
        entry.sockets = staticSlots.map((s, i) => ({
          socket_type: s.socket_type,
          gem_name: equippedGems[i] || null,
        }));
      }

      itemsBySlot[slot] = entry;
    }

    const equipmentList = SLOT_ORDER.filter(s => itemsBySlot[s]).map(s => itemsBySlot[s]);
    for (const [slot, item] of Object.entries(itemsBySlot)) {
      if (!SLOT_ORDER.includes(slot)) equipmentList.push(item);
    }

    // Talents
    const treeNames = CLASS_TREES[classId] || ['Tree 1','Tree 2','Tree 3'];
    const posData = loadTalentPositions();
    const classTreesLayout = posData.by_class_id?.[String(classId)] || [];

    const investedByName = {};
    const apiTreeSpent   = [0, 0, 0];
    try {
      const groups = specData?.specialization_groups || [];
      const activeGroup = groups.find(g => g.is_active) || groups[0] || null;
      if (activeGroup) {
        (activeGroup.specializations || []).forEach((spec, i) => {
          apiTreeSpent[i] = spec.spent_points || 0;
          for (const t of (spec.talents || [])) {
            const spell = t.spell_tooltip?.spell || {};
            const tname = spell.name || '';
            if (tname) {
              investedByName[tname.toLowerCase().trim()] = {
                spell_id:    spell.id,
                talent_id:   t.talent?.id,
                rank:        t.talent_rank || 1,
                description: t.spell_tooltip?.description || '',
                name:        tname,
              };
            }
          }
        });
      }
    } catch {}

    // Collect all talent icon names and fetch in parallel
    const allTalentIconNames = new Set();
    for (let i = 0; i < treeNames.length; i++) {
      const layout = classTreesLayout[i]?.talents || [];
      for (const pos of layout) {
        if (pos.icon) allTalentIconNames.add(pos.icon);
      }
    }
    const uncachedIcons = [...allTalentIconNames].filter(n => !_iconDataCache.has(n));
    if (uncachedIcons.length > 0) {
      await Promise.all(uncachedIcons.map(n => fetchIconDataUri(n, 'medium')));
    }

    // Build talent trees
    const talentTrees = treeNames.map((treeName, treeIdx) => {
      const spent     = apiTreeSpent[treeIdx] || 0;
      const layout    = classTreesLayout[treeIdx]?.talents || [];
      const talents   = layout.map(pos => {
        if (!pos.spell_id) return null;
        const posName = (pos.name || '').toLowerCase().trim();
        const inv     = investedByName[posName] || {};
        const rank    = inv.rank || 0;
        const iconName = pos.icon || null;
        return {
          spell_id:    pos.spell_id,
          talent_id:   inv.talent_id || null,
          row:         pos.row,
          col:         pos.col,
          max_rank:    pos.max_rank,
          rank,
          name:        pos.name || inv.name || '',
          icon:        iconName,
          icon_data:   iconName ? (_iconDataCache.get(iconName) || null) : null,
          description: rank > 0 ? (inv.description || '') : '',
        };
      }).filter(Boolean);
      return { name: treeName, spent_points: spent, talents };
    });

    const totalPoints  = talentTrees.reduce((a, t) => a + t.spent_points, 0);
    const specSummary  = talentTrees.map(t => t.spent_points).join('/');

    let lastLogin = null;
    if (profile.last_login_timestamp) {
      lastLogin = new Date(profile.last_login_timestamp).toISOString().slice(0,16).replace('T',' ');
    }

    return res.json({
      character: {
        name:                profile.name || name,
        level:               profile.level || 0,
        class_id:            classId,
        class_name:          className,
        class_color:         classColor,
        race_id:             raceId,
        race_name:           raceName,
        gender:              genderType,
        faction:             profile.faction?.type || '',
        equipped_item_level: profile.equipped_item_level || null,
        average_item_level:  profile.average_item_level  || null,
        avatar:              avatarUrl,
        avatar_data:         avatarData,
        class_icon_data:     classIconData,
        last_login:          lastLogin,
        realm:               'Thunderstrike EU',
      },
      equipment: equipmentList,
      talents: {
        trees:        talentTrees,
        spec_summary: specSummary,
        total_points: totalPoints,
        tree_names:   treeNames,
      },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
