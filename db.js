const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  console.warn('DNS server set warning:', e.message);
}

let MongoClient = null;
try {
  MongoClient = require('mongodb').MongoClient;
} catch (e) {
  // Offline JSON database mode active
}
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const uri = process.env.MONGODB_URI;
const DATA_DIR = path.join(__dirname, 'data');

let client = null;
let db = null;
let isConnected = false;

async function initMongoDB() {
  if (!uri || !MongoClient) return;
  try {
    client = new MongoClient(uri, {
      connectTimeoutMS: 8000,
      serverSelectionTimeoutMS: 8000
    });
    await client.connect();
    db = client.db('hisab_db');
    isConnected = true;
    console.log('✅ MongoDB Atlas Cloud Database connected successfully!');

    // Sync cloud data to local files on startup
    await syncFromCloudToLocal();
  } catch (err) {
    isConnected = false;
    console.error('⚠️ MongoDB Cloud connection failed (using local JSON files):', err.message);
  }
}

async function syncFromCloudToLocal() {
  if (!isConnected || !db) return;
  try {
    console.log('🔄 Checking and syncing data from MongoDB Cloud...');
    
    // 1. Settings
    const cloudSettings = await db.collection('settings').findOne({ _id: 'global_settings' });
    if (cloudSettings) {
      const { _id, ...cleanSettings } = cloudSettings;
      fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(cleanSettings, null, 2), 'utf8');
    }

    // 2. Records
    const cloudRecords = await db.collection('records').find({}).toArray();
    if (cloudRecords && cloudRecords.length > 0) {
      const recordsMap = {};
      for (const rec of cloudRecords) {
        const { _id, ...cleanRec } = rec;
        recordsMap[_id] = cleanRec;
      }
      fs.writeFileSync(path.join(DATA_DIR, 'records.json'), JSON.stringify(recordsMap, null, 2), 'utf8');
      console.log(`📥 Synced ${cloudRecords.length} records from MongoDB Cloud.`);
    }

    // 3. Employees
    const cloudEmployees = await db.collection('employees').find({}).toArray();
    if (cloudEmployees && cloudEmployees.length > 0) {
      const list = cloudEmployees.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'employees.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    // 4. Uchak
    const cloudUchak = await db.collection('uchak').find({}).toArray();
    if (cloudUchak && cloudUchak.length > 0) {
      const list = cloudUchak.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'uchak.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    // 5. Bank Deposits
    const cloudBank = await db.collection('bank_deposits').find({}).toArray();
    if (cloudBank && cloudBank.length > 0) {
      const list = cloudBank.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'bank_deposits.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    // 6. Bhakts
    const cloudBhakts = await db.collection('bhakts').find({}).toArray();
    if (cloudBhakts && cloudBhakts.length > 0) {
      const list = cloudBhakts.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'bhakts.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    // 7. Bhakt Deposits
    const cloudBhaktDep = await db.collection('bhakt_deposits').find({}).toArray();
    if (cloudBhaktDep && cloudBhaktDep.length > 0) {
      const list = cloudBhaktDep.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'bhakt_deposits.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    // 8. Dues (લેણાં અને દેવાં)
    const cloudDues = await db.collection('dues').find({}).toArray();
    if (cloudDues && cloudDues.length > 0) {
      const list = cloudDues.map(({ _id, ...rest }) => rest);
      fs.writeFileSync(path.join(DATA_DIR, 'dues.json'), JSON.stringify(list, null, 2), 'utf8');
    }

    console.log('✅ Local cache fully synchronized with MongoDB Cloud!');
  } catch (err) {
    console.error('Error during cloud to local sync:', err.message);
  }
}

// Background Cloud Upserts (Fire-and-forget safe async)
function syncSettingsToCloud(settings) {
  if (!isConnected || !db) return;
  db.collection('settings').updateOne(
    { _id: 'global_settings' },
    { $set: { _id: 'global_settings', ...settings } },
    { upsert: true }
  ).catch(e => console.error('Cloud save settings error:', e.message));
}

function syncRecordToCloud(date, record) {
  if (!isConnected || !db) return;
  db.collection('records').updateOne(
    { _id: date },
    { $set: { _id: date, ...record } },
    { upsert: true }
  ).catch(e => console.error('Cloud save record error:', e.message));
}

function syncAllRecordsToCloud(records) {
  if (!isConnected || !db) return;
  const entries = Object.entries(records);
  for (const [date, rec] of entries) {
    db.collection('records').updateOne(
      { _id: date },
      { $set: { _id: date, ...rec } },
      { upsert: true }
    ).catch(e => console.error('Cloud save bulk record error:', e.message));
  }
}

async function syncListToCloud(collectionName, list) {
  if (!isConnected || !db) return;
  try {
    const col = db.collection(collectionName);
    const validIds = [];
    if (Array.isArray(list) && list.length > 0) {
      for (let idx = 0; idx < list.length; idx++) {
        const item = list[idx];
        const docId = String(item.id || item._id || `${collectionName}_${idx}`);
        validIds.push(docId);
        const { _id, ...cleanData } = item;
        await col.updateOne(
          { _id: docId },
          { $set: { _id: docId, ...cleanData } },
          { upsert: true }
        );
      }
    }
    // Delete items that were removed from the list
    await col.deleteMany({ _id: { $nin: validIds } });
  } catch (e) {
    console.error(`Cloud save ${collectionName} error:`, e.message);
  }
}

async function checkRealtimeCloudStatus() {
  if (!client || !db) return false;
  try {
    await db.command({ ping: 1 }, { maxTimeMS: 2000 });
    isConnected = true;
    return true;
  } catch (err) {
    isConnected = false;
    return false;
  }
}

module.exports = {
  initMongoDB,
  getCloudStatus: () => isConnected,
  checkRealtimeCloudStatus,
  syncSettingsToCloud,
  syncRecordToCloud,
  syncAllRecordsToCloud,
  syncListToCloud,
  syncFromCloudToLocal
};
