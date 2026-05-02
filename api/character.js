'use strict';

const https = require('https');
const path  = require('path');
const fs    = require('fs');

const CLIENT_ID     = '5f3738add0b24ac98330ae54297e0ebf';
const CLIENT_SECRET = '1xl9pT7JdMwd64hDHsc7KsHmbjugTpGs';
const REALM_SLUG    = 'thunderstrike';
const REGION        = 'eu';
const LOCALE        = 'en_GB';
const PROFILE_NS    = 'profile-classicann-eu';
const STATIC_NS     = 'static-classicann-eu';

const CLASS_COLORS = {
  1:'#C79C6E',2:'#F58CBA',3:'#ABD473',4:'#FFF569',
  5:'#FFFFFF',6:'#C41F3B',7:'#0070DE',8:'#69CCF0',
  9:'#9482C9',10:'#00FF96',11:'#FF7D0A',
};
const CLASS_NAMES = {
  1:'Warrior',2:'Paladin',3:'Hunter',4:'Rogue',5:'Priest',
  6:'Death Knight',7:'Shaman',8:'Mage',9:'Warlock',10:'Monk',11:'Druid',
};
const CLASS_ICONS = {
  1:'classicon_warrior',2:'classicon_paladin',3:'classicon_hunter',
  4:'classicon_rogue',5:'classicon_priest',6:'classicon_deathknight',
  7:'classicon_shaman',8:'classicon_mage',9:'classicon_warlock',
  10:'classicon_monk',11:'classicon_druid',
};
const RACE_NAMES = {
  1:'Human',2:'Orc',3:'Dwarf',4:'Night Elf',5:'Undead',6:'Tauren',
  7:'Gnome',8:'Troll',10:'Blood Elf',11:'Draenei',
};
const QUALITY_COLORS = {
  0:'#9d9d9d',1:'#ffffff',2:'#1eff00',3:'#0070dd',4:'#a335ee',5:'#ff8000',
};
const SLOT_ORDER = [
  'HEAD','NECK','SHOULDER','BACK','CHEST','WRIST',
  'HANDS','WAIST','LEGS','FEET','FINGER_1','FINGER_2',
  'TRINKET_1','TRINKET_2','MAIN_HAND','OFF_HAND','RANGED',
];

let talentPositions = null;
function getTalentPositions() {
  if (!talentPositions) {
    const p = path.join(__dirname, 'talent_positions.json');
    talentPositions = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return talentPositions;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpGetJson(url, headers = {}) {
  return httpGet(url, headers).then(r => {
    try { return { status: r.status, data: JSON.parse(r.body.toString()) }; }
    catch { return { status: r.status, data: null }; }
  });
}

function fetchBase64(url) {
  return httpGet(url).then(r => {
    if (r.status !== 200) return null;
    const mime = r.headers['content-type'] || 'image/jpeg';
    return `data:${mime};base64,${r.body.toString('base64')}`;
  }).catch(() => null);
}

// ── Blizzard auth ─────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body   = 'grant_type=client_credentials';
  const result = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: `${REGION}.battle.net`, path: '/oauth/token', method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }},
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  cachedToken = result.access_token;
  tokenExpiry  = Date.now() + (result.expires_in - 60) * 1000;
  return cachedToken;
}

function blizzardUrl(path, ns, extra = '') {
  return `https://${REGION}.api.blizzard.com${path}?namespace=${ns}&locale=${LOCALE}${extra}`;
}

async function blizzGet(url, token) {
  return httpGetJson(url, { Authorization: `Bearer ${token}` });
}

// ── Icon fetching ─────────────────────────────────────────────────────────────
const iconCache = new Map();

async function fetchIconBase64(iconName) {
  if (!iconName) return null;
  const key = iconName.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  const url = `https://wow.zamimg.com/images/wow/icons/large/${key}.jpg`;
  const data = await fetchBase64(url);
  iconCache.set(key, data);
  return data;
}

// ── Item static data ──────────────────────────────────────────────────────────
const itemCache = new Map();

async function fetchItemStatic(itemId, token) {
  if (itemCache.has(itemId)) return itemCache.get(itemId);
  const url = blizzardUrl(`/data/wow/item/${itemId}`, STATIC_NS);
  const { status, data } = await blizzGet(url, token);
  if (status !== 200 || !data) { itemCache.set(itemId, null); return null; }

  // Extract sockets
  const sockets = [];
  const socketTypes = [];
  if (data.preview_item) {
    const pi = data.preview_item;
    if (pi.sockets) {
      pi.sockets.forEach(s => {
        sockets.push(s.socket_type ? s.socket_type.type : 'PRISMATIC');
        socketTypes.push(s.socket_type ? s.socket_type.type : 'PRISMATIC');
      });
    }
  }

  // Extract stats from preview_item
  const stats = [];
  if (data.preview_item && data.preview_item.stats) {
    data.preview_item.stats.forEach(s => {
      stats.push({ type: s.type ? s.type.type : '', value: s.value || 0, display: s.display ? s.display.display_string : '' });
    });
  }

  // Extract spells/equip effects
  const spells = [];
  if (data.preview_item && data.preview_item.spells) {
    data.preview_item.spells.forEach(s => {
      if (s.description) spells.push(s.description);
    });
  }

  const result = {
    item_level: data.level || 0,
    socket_count: sockets.length,
    socket_types: socketTypes,
    stats,
    spells,
    set_name: data.item_set ? data.item_set.name : null,
    required_level: data.required_level || 0,
    item_subclass: data.item_subclass ? data.item_subclass.name : null,
    binding: data.preview_item && data.preview_item.binding ? data.preview_item.binding.name : null,
    armor: data.preview_item && data.preview_item.armor ? data.preview_item.armor.value : null,
    weapon: data.preview_item && data.preview_item.weapon ? data.preview_item.weapon : null,
    durability: data.preview_item && data.preview_item.durability ? data.preview_item.durability.value : null,
  };
  itemCache.set(itemId, result);
  return result;
}

// ── Build gear list ───────────────────────────────────────────────────────────
async function buildGear(equippedItems, token) {
  const gearMap = {};
  await Promise.all(equippedItems.map(async (item) => {
    const slotType = item.slot ? item.slot.type : null;
    if (!slotType) return;

    const itemId   = item.item ? item.item.id : null;
    const quality  = item.quality ? item.quality.type : 'COMMON';
    const qualityN = quality.charAt(0) + quality.slice(1).toLowerCase();
    const qualIdx  = ['Poor','Common','Uncommon','Rare','Epic','Legendary'].indexOf(qualityN);
    const qualColor = QUALITY_COLORS[qualIdx >= 0 ? qualIdx : 1];

    // Fetch icon
    let iconData = null;
    const mediaHref = item.media && item.media.key ? item.media.key.href : null;
    if (mediaHref) {
      const { data: mediaData } = await blizzGet(mediaHref, token).catch(() => ({ data: null }));
      const iconUrl = mediaData && mediaData.assets ? (mediaData.assets.find(a => a.key === 'icon') || {}).value : null;
      if (iconUrl) {
        // Extract icon name from URL
        const match = iconUrl.match(/icons\/large\/(.+?)(?:\.jpg)?$/);
        if (match) iconData = await fetchIconBase64(match[1]);
        else iconData = await fetchBase64(iconUrl);
      }
    }

    // Fetch static data
    let staticData = null;
    if (itemId) staticData = await fetchItemStatic(itemId, token);

    // Enchant
    let enchant = null;
    if (item.enchantments && item.enchantments.length > 0) {
      enchant = item.enchantments[0].display_string || item.enchantments[0].enchantment_id;
    }

    // Gems
    const gems = [];
    if (item.sockets) {
      item.sockets.forEach(s => {
        gems.push({ name: s.item ? s.item.name : null, icon: null, color: s.socket_type ? s.socket_type.type : null });
      });
    }

    gearMap[slotType] = {
      id: itemId,
      name: item.name || '',
      slot: slotType,
      quality: qualityN,
      quality_color: qualColor,
      icon_data: iconData,
      item_level: staticData ? staticData.item_level : 0,
      enchant,
      gems,
      socket_count: staticData ? staticData.socket_count : 0,
      socket_types: staticData ? staticData.socket_types : [],
      stats: staticData ? staticData.stats : [],
      spells: staticData ? staticData.spells : [],
      binding: staticData ? staticData.binding : null,
      armor: staticData ? staticData.armor : null,
      weapon: staticData ? staticData.weapon : null,
      durability: staticData ? staticData.durability : null,
      required_level: staticData ? staticData.required_level : 0,
      item_subclass: staticData ? staticData.item_subclass : null,
    };
  }));
  return gearMap;
}

// ── Build talents ─────────────────────────────────────────────────────────────
async function buildTalents(charData, specData, token) {
  const classId = charData.character_class ? charData.character_class.id : null;
  if (!classId) return { class_id: null, trees: [] };

  const positions = getTalentPositions();
  const classKey  = String(classId);
  const classTalents = positions[classKey] || {};

  // Get spent talents from spec data
  const spentMap = {};
  if (specData && specData.specializations) {
    specData.specializations.forEach(spec => {
      if (spec.talents) {
        spec.talents.forEach(t => {
          const sid = t.spell_tooltip ? t.spell_tooltip.spell ? t.spell_tooltip.spell.id : null : null;
          const tid = t.talent ? t.talent.id : null;
          if (tid) spentMap[tid] = t.talent_rank || 1;
          if (sid) spentMap[`spell_${sid}`] = t.talent_rank || 1;
        });
      }
    });
  }

  // Build trees
  const treeResults = [];
  for (const [treeName, talents] of Object.entries(classTalents)) {
    const talentList = [];
    for (const talent of talents) {
      const iconData = talent.icon ? await fetchIconBase64(talent.icon) : null;
      const rank = spentMap[talent.talent_id] || spentMap[`spell_${talent.spell_id}`] || 0;
      talentList.push({
        talent_id: talent.talent_id,
        spell_id: talent.spell_id,
        name: talent.name,
        description: talent.description || '',
        icon: talent.icon,
        icon_data: iconData,
        max_rank: talent.max_rank || 5,
        rank,
        row: talent.row,
        col: talent.col,
      });
    }
    treeResults.push({ tree: treeName, talents: talentList });
  }

  return { class_id: classId, trees: treeResults };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const name = (req.query.name || '').trim().toLowerCase();
  if (!name) {
    res.status(400).json({ error: 'Missing name parameter' });
    return;
  }

  try {
    const token = await getToken();

    // Fetch character + equipment + specs in parallel
    const [charRes, equipRes, specRes] = await Promise.all([
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}`, PROFILE_NS), token),
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}/equipment`, PROFILE_NS), token),
      blizzGet(blizzardUrl(`/profile/wow/character/${REALM_SLUG}/${name}/specializations`, PROFILE_NS), token).catch(() => ({ data: null })),
    ]);

    if (charRes.status === 404 || !charRes.data || charRes.data.code === 404) {
      res.status(404).json({ error: `Character "${name}" not found on Thunderstrike EU. Check the name spelling and try again. Only Thunderstrike EU characters are supported.` });
      return;
    }
    if (charRes.status !== 200) {
      res.status(500).json({ error: `Blizzard API error ${charRes.status} for character lookup` });
      return;
    }

    const charData  = charRes.data;
    const equipData = equipRes.data || {};
    const specData  = specRes.data || {};

    const classId   = charData.character_class ? charData.character_class.id : null;
    const className = charData.character_class ? charData.character_class.name : 'Unknown';
    const raceId    = charData.race ? charData.race.id : null;
    const raceName  = charData.race ? charData.race.name : 'Unknown';
    const classColor = CLASS_COLORS[classId] || '#FFFFFF';

    // Fetch avatar + class icon in parallel with gear
    const avatarUrl    = charData.render_url || null;
    const classIconKey = CLASS_ICONS[classId] || 'classicon_warrior';

    const [gearMap, talentData, avatarData, classIconData] = await Promise.all([
      buildGear(equipData.equipped_items || [], token),
      buildTalents(charData, specData, token),
      avatarUrl ? fetchBase64(avatarUrl) : Promise.resolve(null),
      fetchIconBase64(classIconKey),
    ]);

    // Build ordered gear array
    const gear = SLOT_ORDER.map(slot => gearMap[slot] || null).filter(Boolean);

    res.status(200).json({
      name: charData.name || name,
      level: charData.level || 0,
      class_id: classId,
      class_name: className,
      class_color: classColor,
      race_id: raceId,
      race_name: raceName,
      faction: charData.faction ? charData.faction.name : 'Unknown',
      realm: 'Thunderstrike',
      region: 'EU',
      gender: charData.gender ? charData.gender.name : null,
      average_item_level: charData.average_item_level || 0,
      equipped_item_level: charData.equipped_item_level || 0,
      avatar_url: avatarUrl,
      avatar_data: avatarData,
      class_icon_data: classIconData,
      gear,
      talents: talentData,
      cached: false,
      cache_age: 0,
    });
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
};
