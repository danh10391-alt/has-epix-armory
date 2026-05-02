'use strict';

const https = require('https');
const path  = require('path');
const fs    = require('fs');

// ── Constants ────────────────────────────────────────────────────────────────
const CLIENT_ID     = '5f3738add0b24ac98330ae54297e0ebf';
const CLIENT_SECRET = '1xl9pT7JdMwd64hDHsc7KsHmbjugTpGs';
const REALM_SLUG    = 'thunderstrike';
const REGION        = 'eu';
const LOCALE        = 'en_GB';

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

// Talent positions (loaded once)
let talentPositions = null;
function getTalentPositions() {
  if (!talentPositions) {
    const p = path.join(__dirname, 'talent_positions.json');
    talentPositions = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return talentPositions;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
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

// ── OAuth ────────────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry  = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const postData = 'grant_type=client_credentials';
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'eu.battle.net',
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
  cachedToken = result.access_token;
  tokenExpiry = Date.now() + (result.expires_in - 60) * 1000;
  return cachedToken;
}

// ── Blizzard API calls ───────────────────────────────────────────────────────
async function blizzardGet(urlPath, namespace, token) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const url = `https://${REGION}.api.blizzard.com${urlPath}${sep}namespace=${namespace}&locale=${LOCALE}`;
  return httpGetJson(url, { 'Authorization': `Bearer ${token}` });
}

async function fetchItemStaticData(itemId, token) {
  const r = await blizzardGet(`/data/wow/item/${itemId}`, 'static-classic-eu', token);
  if (r.status !== 200 || !r.data) return { sockets: [], item_level: null };
  const d = r.data;
  const sockets = (d.preview_item?.sockets || []).map(s => ({
    socket_type: s.socket_type?.type || 'PRISMATIC',
  }));
  const item_level = d.level?.value || null;
  return { sockets, item_level };
}

async function fetchWowheadTooltip(spellId) {
  try {
    const r = await httpGetJson(
      `https://nether.wowhead.com/tooltip/spell/${spellId}?dataEnv=4&locale=0`
    );
    return r.data;
  } catch { return null; }
}

// ── Icon helpers ─────────────────────────────────────────────────────────────
const iconCache = new Map();

async function getIconBase64(iconName) {
  if (!iconName) return null;
  const key = iconName.toLowerCase();
  if (iconCache.has(key)) return iconCache.get(key);
  const url = `https://wow.zamimg.com/images/wow/icons/large/${key}.jpg`;
  const data = await fetchBase64(url);
  iconCache.set(key, data);
  return data;
}

// ── Build equipment list ─────────────────────────────────────────────────────
async function buildEquipment(equippedItems, token) {
  if (!equippedItems || !equippedItems.length) return [];

  // Fetch static data for all items in parallel
  const staticData = await Promise.all(
    equippedItems.map(item => fetchItemStaticData(item.item?.id, token))
  );

  // Fetch all icons in parallel
  const iconNames = equippedItems.map(item => item.media?.assets?.[0]?.value
    ? null // will use media URL
    : (item.name || '').toLowerCase().replace(/\s+/g, '_')
  );

  // For item icons, use the Blizzard icon name from the item data
  const itemIconFetches = equippedItems.map(async (item, i) => {
    // Try to get icon name from item spells / display info
    const iconName = item.name ? item.name.toLowerCase().replace(/[^a-z0-9_]/g, '_') : 'inv_misc_questionmark';
    return getIconBase64(iconName);
  });

  // Actually fetch item media to get real icon names
  const mediaFetches = equippedItems.map(async (item) => {
    const itemId = item.item?.id;
    if (!itemId) return null;
    const r = await blizzardGet(`/data/wow/media/item/${itemId}`, 'static-classic-eu', token);
    if (r.status !== 200 || !r.data) return null;
    // Extract icon name from the URL
    const assets = r.data.assets || [];
    const iconAsset = assets.find(a => a.key === 'icon');
    if (!iconAsset) return null;
    // URL like https://render.worldofwarcraft.com/eu/icons/56/inv_sword_04.jpg
    const match = iconAsset.value.match(/\/([^\/]+)\.jpg$/i);
    if (!match) return null;
    return match[1].toLowerCase();
  });

  const [mediaIconNames] = await Promise.all([
    Promise.all(mediaFetches),
  ]);

  // Fetch base64 for all icons
  const iconBase64s = await Promise.all(
    mediaIconNames.map(name => name ? getIconBase64(name) : null)
  );

  const result = [];
  for (let i = 0; i < equippedItems.length; i++) {
    const item = equippedItems[i];
    const sd   = staticData[i];
    const slot = item.slot?.type || 'UNKNOWN';

    // Enchants
    const enchants = [];
    if (item.enchantments) {
      for (const e of item.enchantments) {
        enchants.push({
          enchant_id:   e.enchantment_id || 0,
          display_string: e.display_string || '',
          enchant_name: e.enchantment_slot?.type || '',
        });
      }
    }

    // Gems
    const gems = [];
    if (item.sockets) {
      for (const s of item.sockets) {
        if (s.item) {
          gems.push({
            gem_id:    s.item.id || 0,
            gem_name:  s.item.name || '',
            icon_name: '',
            icon_data: null,
          });
        }
      }
    }

    // Stats
    const stats = [];
    if (item.stats) {
      for (const s of item.stats) {
        stats.push({
          type:   s.type?.type || '',
          value:  s.value || 0,
          display: s.display?.display_string || `+${s.value} ${s.type?.type || ''}`,
        });
      }
    }

    // Spells / procs
    const spells = [];
    if (item.spells) {
      for (const s of item.spells) {
        spells.push({
          spell_id:    s.spell?.id || 0,
          trigger:     s.trigger_type?.type || 'ON_USE',
          description: s.description || '',
        });
      }
    }

    result.push({
      slot,
      item_id:       item.item?.id || 0,
      name:          item.name || '',
      quality:       item.quality?.type || 'COMMON',
      quality_value: item.quality?.type === 'LEGENDARY' ? 5
                   : item.quality?.type === 'EPIC' ? 4
                   : item.quality?.type === 'RARE' ? 3
                   : item.quality?.type === 'UNCOMMON' ? 2
                   : item.quality?.type === 'POOR' ? 0 : 1,
      icon_name:     mediaIconNames[i] || '',
      icon_data:     iconBase64s[i] || null,
      item_level:    sd.item_level,
      binding:       item.binding?.type || '',
      item_class:    item.item_class?.name || '',
      item_subclass: item.item_subclass?.name || '',
      inventory_type: slot,
      durability:    item.durability?.value || null,
      stats,
      enchants,
      gems,
      empty_sockets: sd.sockets,
      spells,
      requirements:  item.requirements ? {
        level: item.requirements.level?.value || null,
      } : null,
      set_name:      item.set?.item_set?.name || null,
    });
  }

  return result;
}

// ── Build talent trees ────────────────────────────────────────────────────────
async function buildTalents(talentData, classId) {
  const positions = getTalentPositions();
  const classKey  = String(classId);
  const classTalents = positions[classKey] || {};

  const trees = {};
  const treeNames = {};
  let totalPoints = 0;

  if (!talentData || !talentData.talent_loadout) return { trees, treeNames, totalPoints };

  const spentTalents = talentData.talent_loadout?.selected_class_talents || [];

  // Map spell_id → rank
  const spentMap = {};
  for (const t of spentTalents) {
    if (t.id) spentMap[t.id] = t.rank || 1;
  }

  // Build tree structure from positions
  for (const [talentId, tPos] of Object.entries(classTalents)) {
    const treeName = tPos.tree || 'Unknown';
    const treeIdx  = tPos.tree_index !== undefined ? tPos.tree_index : 0;

    if (!treeNames[treeIdx]) treeNames[treeIdx] = treeName;
    if (!trees[treeIdx]) trees[treeIdx] = { name: treeName, talents: [] };

    const rank = spentMap[parseInt(talentId)] || 0;
    totalPoints += rank;

    trees[treeIdx].talents.push({
      talent_id:  parseInt(talentId),
      spell_id:   parseInt(talentId),
      name:       tPos.name || '',
      icon_name:  tPos.icon || '',
      icon_data:  null,
      row:        tPos.row || 0,
      col:        tPos.col || 0,
      max_rank:   tPos.max_rank || 1,
      rank,
      prereq:     tPos.prereq || null,
      tree_index: treeIdx,
    });
  }

  // Fetch icons for spent talents in parallel (only ones with rank > 0)
  const iconFetches = [];
  for (const tree of Object.values(trees)) {
    for (const t of tree.talents) {
      if (t.rank > 0 && t.icon_name) {
        iconFetches.push(
          getIconBase64(t.icon_name).then(data => { t.icon_data = data; })
        );
      } else if (t.icon_name) {
        iconFetches.push(
          getIconBase64(t.icon_name).then(data => { t.icon_data = data; })
        );
      }
    }
  }
  await Promise.all(iconFetches);

  return {
    trees: Object.values(trees),
    treeNames: Object.values(treeNames),
    totalPoints,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const charName = (req.query.name || '').trim();
  if (!charName) {
    return res.status(400).json({ error: 'Missing character name' });
  }
  const safeChar = charName.toLowerCase().replace(/[^a-z0-9-]/g, '');

  try {
    const token = await getToken();

    // Parallel: profile + equipment + talents
    const [profileR, equipR, talentR] = await Promise.all([
      blizzardGet(
        `/profile/wow/character/${REALM_SLUG}/${safeChar}`,
        'profile-classic-eu', token
      ),
      blizzardGet(
        `/profile/wow/character/${REALM_SLUG}/${safeChar}/equipment`,
        'profile-classic-eu', token
      ),
      blizzardGet(
        `/profile/wow/character/${REALM_SLUG}/${safeChar}/specializations`,
        'profile-classic-eu', token
      ),
    ]);

    if (profileR.status === 404) {
      return res.status(404).json({ error: `Character "${charName}" not found on Thunderstrike EU` });
    }
    if (profileR.status !== 200 || !profileR.data) {
      return res.status(500).json({ error: `Blizzard API error (${profileR.status})` });
    }

    const profile   = profileR.data;
    const classId   = profile.character_class?.id || 0;
    const className = CLASS_NAMES[classId] || profile.character_class?.name || 'Unknown';
    const classColor = CLASS_COLORS[classId] || '#ffffff';
    const raceId    = profile.race?.id || 0;
    const raceName  = RACE_NAMES[raceId] || profile.race?.name || 'Unknown';
    const genderType = profile.gender?.type || 'MALE';

    // Avatar
    const avatarUrl = profile.media?.href || null;
    let avatarData  = null;
    if (avatarUrl) {
      // Fetch media to get the actual render URL
      const mediaR = await httpGetJson(avatarUrl, { 'Authorization': `Bearer ${token}` });
      if (mediaR.status === 200 && mediaR.data) {
        const assets = mediaR.data.assets || [];
        const avatar = assets.find(a => a.key === 'avatar');
        if (avatar) avatarData = await fetchBase64(avatar.value);
      }
    }

    // Class icon fallback
    const classIconName = CLASS_ICONS[classId];
    const classIconData = classIconName ? await getIconBase64(classIconName) : null;

    // Last login
    let lastLogin = null;
    if (profile.last_login_timestamp) {
      lastLogin = new Date(profile.last_login_timestamp).toISOString().split('T')[0];
    }

    // Equipment
    const equippedItems = equipR.status === 200 ? (equipR.data?.equipped_items || []) : [];
    const equipmentList = await buildEquipment(equippedItems, token);

    // Talents
    const talentData  = talentR.status === 200 ? talentR.data : null;
    const { trees: talentTrees, treeNames, totalPoints } = await buildTalents(talentData, classId);

    // Spec summary
    let specSummary = '';
    if (talentTrees && talentTrees.length > 0) {
      const treeCounts = talentTrees.map(t => {
        const pts = t.talents.reduce((s, x) => s + x.rank, 0);
        return `${pts} ${t.name}`;
      });
      specSummary = treeCounts.join(' / ');
    }

    return res.status(200).json({
      character: {
        name:                profile.name || charName,
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
      equipment:  equipmentList,
      talents: {
        trees:        talentTrees,
        spec_summary: specSummary,
        total_points: totalPoints,
        tree_names:   treeNames,
      },
    });

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
