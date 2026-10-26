const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const simpleGit = require('simple-git');

const app = express();
const PORT = process.env.PORT || 3000;
const BOTS_DIR = path.join(__dirname, 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors = require('cors')());

const storage = multer.diskStorage({
  destination: '/tmp',
  filename: (req,file,cb)=>cb(null, Date.now()+'-'+file.originalname)
});
const upload = multer({ storage });

let bots = [];
let processes = {};

// Load bots.json if exists
try{ if(fs.existsSync('./bots.json')) bots = JSON.parse(fs.readFileSync('./bots.json')); }catch{}

function saveBots(){ fs.writeFileSync('./bots.json', JSON.stringify(bots,null,2)); }

function runBot(botId, botPath, entryFile, sessionId){
  const env = {...process.env, SESSION_ID: sessionId, SESSION: sessionId};
  const child = spawn('node', [entryFile], { cwd: botPath, env });
  processes[botId] = child;
  bots.find(b=>b.id===botId).logs = [];
  bots.find(b=>b.id===botId).status = 'online';
  
  child.stdout.on('data', d=>{
    let log = d.toString().slice(0,500);
    bots.find(b=>b.id===botId).logs.push(log);
    if(bots.find(b=>b.id===botId).logs.length>100) bots.find(b=>b.id===botId).logs.shift();
  });
  child.stderr.on('data', d=>{
    bots.find(b=>b.id===botId).logs.push('ERR: '+d.toString().slice(0,500));
  });
  child.on('close', ()=>{
    let b = bots.find(x=>x.id===botId);
    if(b) b.status='offline';
  });
}

app.get('/api/bots', (req,res)=>res.json(bots));

app.post('/api/deploy', upload.single('zipFile'), async (req,res)=>{
  try{
    const { sessionId, repoUrl, botFile, botName } = req.body;
    if(!sessionId) return res.status(400).json({error:'SESSION_ID required'});
    
    const id = Date.now().toString();
    const botPath = path.join(BOTS_DIR, id);
    fs.mkdirSync(botPath, {recursive:true});
    
    const entry = botFile || 'index.js';
    
    // 1. Clone repo or unzip
    if(req.file){
      // ZIP upload
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(botPath, true);
      fs.unlinkSync(req.file.path);
    } else if(repoUrl){
      // Git clone
      await simpleGit().clone(repoUrl, botPath);
    } else {
      // Default: Clone HONOR-XMD
      await simpleGit().clone('https://github.com/prodev-ofc/HONOR-XMD.git', botPath);
    }
    
    // 2. Write SESSION_ID to .env and config
    fs.writeFileSync(path.join(botPath,'.env'), `SESSION_ID=${sessionId}\n`);
    // Try to patch common config files
    try{
      let configPath = path.join(botPath,'config.js');
      if(fs.existsSync(configPath)){
        let c = fs.readFileSync(configPath,'utf8');
        c = c.replace(/SESSION_ID.*=.*["'].*["']/g, `SESSION_ID = "${sessionId}"`);
        fs.writeFileSync(configPath,c);
      }
    }catch{}

    const bot = {
      id, name: botName||'HONOR-XMD', repo: repoUrl||'HONOR-XMD',
      entry, status:'installing', logs:[], sessionId: sessionId.slice(0,25)+'...',
      created: new Date().toISOString()
    };
    bots.push(bot); saveBots();

    // 3. npm install
    exec('npm install --no-audit --no-fund', {cwd: botPath}, (err)=>{
      if(err) bot.logs.push('Install error: '+err.message);
      bot.status='starting';
      // 4. Run bot
      setTimeout(()=> runBot(id, botPath, entry, sessionId), 2000);
    });

    res.json({success:true, bot, message:'Bot is installing and will go online in 10-20s'});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message});
  }
});

app.get('/api/bots/:id/logs', (req,res)=>{
  let b = bots.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'not found'});
  res.json({logs: b.logs||[]});
});

app.post('/api/bots/:id/:action', (req,res)=>{
  let b = bots.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'not found'});
  if(req.params.action==='stop' && processes[b.id]){ processes[b.id].kill(); b.status='offline'; }
  if(req.params.action==='delete'){ if(processes[b.id]) processes[b.id].kill(); bots = bots.filter(x=>x.id!==b.id); saveBots(); }
  res.json({success:true});
});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
app.listen(PORT, ()=>console.log('OS-PANEL v3 running '+PORT));
