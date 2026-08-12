
const express=require('express');
const helmet=require('helmet');
const rateLimit=require('express-rate-limit');
const cookieParser=require('cookie-parser');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const multer=require('multer');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const nodemailer=require('nodemailer');
const {Pool}=require('pg');

const app=express();
app.set('trust proxy',1);
app.disable('x-powered-by');

const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL;
const JWT_SECRET=process.env.JWT_SECRET;
const FEE=Number(process.env.SHOP_FEE_PERCENT||5);
const BANK_NAME=process.env.BANK_NAME||'MB Bank';
const BANK_ACCOUNT=process.env.BANK_ACCOUNT||'11042004102005';
const BANK_ACCOUNT_NAME=process.env.BANK_ACCOUNT_NAME||'';
const HOLD_HOURS=72;

if(!DATABASE_URL){console.error('DATABASE_URL is required');process.exit(1)}
if(!JWT_SECRET || JWT_SECRET.length<32){console.error('JWT_SECRET must be >= 32 chars');process.exit(1)}

const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,
  max:10,idleTimeoutMillis:30000
});

const uploadsDir=path.join(__dirname,'uploads');
fs.mkdirSync(uploadsDir,{recursive:true});
const upload=multer({
  dest:uploadsDir,
  limits:{fileSize:5*1024*1024,files:3},
  fileFilter:(req,file,cb)=>{
    if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype))return cb(new Error('Chỉ nhận JPG/PNG/WEBP'));
    cb(null,true);
  }
});

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'700kb'}));
app.use(express.urlencoded({extended:false,limit:'700kb'}));
app.use(cookieParser());
app.use(rateLimit({windowMs:60_000,max:240,standardHeaders:true,legacyHeaders:false}));
const authLimiter=rateLimit({windowMs:5*60_000,max:25,standardHeaders:true,legacyHeaders:false,message:{error:'Bạn thao tác đăng nhập quá nhiều. Vui lòng thử lại sau ít phút.'}});

function ipOf(req){
  const xf=req.headers['x-forwarded-for'];
  return String(Array.isArray(xf)?xf[0]:(xf||req.ip||'')).split(',')[0].trim().slice(0,120);
}
async function isIpBanned(ip){
  if(!ip)return false;
  const q=await pool.query(`SELECT 1 FROM ip_bans WHERE ip=$1 AND (expires_at IS NULL OR expires_at>NOW())`,[ip]);
  return q.rowCount>0;
}
async function audit(client,actorId,action,targetType,targetId,meta={}){
  await client.query(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,meta) VALUES($1,$2,$3,$4,$5)`,
    [actorId||null,action,targetType||'',targetId?String(targetId):'',JSON.stringify(meta)]);
}
async function ledger(client,userId,kind,amount,refType,refId,note=''){
  await client.query(`INSERT INTO wallet_ledger(user_id,kind,amount,ref_type,ref_id,note) VALUES($1,$2,$3,$4,$5,$6)`,
    [userId,kind,amount,refType||'',refId?String(refId):'',note]);
}
async function initDb(){
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users(
   id BIGSERIAL PRIMARY KEY,
   username VARCHAR(40) UNIQUE NOT NULL,
   email VARCHAR(255) UNIQUE NOT NULL,
   password_hash TEXT NOT NULL,
   role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK(role IN ('member','seller','admin')),
   status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
   phone VARCHAR(30) DEFAULT '',
   seller_verification VARCHAR(20) DEFAULT 'none',
   balance BIGINT NOT NULL DEFAULT 0 CHECK(balance>=0),
   seller_balance BIGINT NOT NULL DEFAULT 0 CHECK(seller_balance>=0),
   held_balance BIGINT NOT NULL DEFAULT 0 CHECK(held_balance>=0),
   register_ip VARCHAR(120) DEFAULT '',
   last_login_ip VARCHAR(120) DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 ALTER TABLE users ADD COLUMN IF NOT EXISTS held_balance BIGINT NOT NULL DEFAULT 0;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS register_ip VARCHAR(120) DEFAULT '';
 ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(120) DEFAULT '';

 CREATE TABLE IF NOT EXISTS seller_applications(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   full_name TEXT NOT NULL, phone TEXT NOT NULL,
   cccd_front TEXT NOT NULL, cccd_back TEXT NOT NULL,
   accepted_rules BOOLEAN NOT NULL DEFAULT FALSE,
   rules_version VARCHAR(30) DEFAULT '2026-08',
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   updated_at TIMESTAMPTZ DEFAULT NOW()
 );
 ALTER TABLE seller_applications ADD COLUMN IF NOT EXISTS accepted_rules BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE seller_applications ADD COLUMN IF NOT EXISTS rules_version VARCHAR(30) DEFAULT '2026-08';

 CREATE TABLE IF NOT EXISTS products(
   id BIGSERIAL PRIMARY KEY,
   seller_id BIGINT NOT NULL REFERENCES users(id),
   game VARCHAR(30) NOT NULL CHECK(game IN ('lienquan','freefire','pubg','khac')),
   title VARCHAR(160) NOT NULL,
   description TEXT NOT NULL,
   price BIGINT NOT NULL CHECK(price>0),
   image TEXT,
   account_login TEXT NOT NULL,
   account_password TEXT NOT NULL,
   warranty_days INT NOT NULL DEFAULT 3 CHECK(warranty_days>=0 AND warranty_days<=365),
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_days INT NOT NULL DEFAULT 3;

 CREATE TABLE IF NOT EXISTS orders(
   id BIGSERIAL PRIMARY KEY,
   buyer_id BIGINT NOT NULL REFERENCES users(id),
   seller_id BIGINT NOT NULL REFERENCES users(id),
   product_id BIGINT NOT NULL REFERENCES products(id),
   amount BIGINT NOT NULL, fee BIGINT NOT NULL, seller_net BIGINT NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'paid',
   release_status VARCHAR(20) NOT NULL DEFAULT 'held',
   hold_until TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '72 hours'),
   released_at TIMESTAMPTZ,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_status VARCHAR(20) NOT NULL DEFAULT 'held';
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '72 hours');
 ALTER TABLE orders ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

 CREATE TABLE IF NOT EXISTS complaints(
   id BIGSERIAL PRIMARY KEY,
   order_id BIGINT NOT NULL REFERENCES orders(id),
   buyer_id BIGINT NOT NULL REFERENCES users(id),
   seller_id BIGINT NOT NULL REFERENCES users(id),
   type VARCHAR(50) NOT NULL,
   description TEXT NOT NULL,
   evidence TEXT DEFAULT '',
   status VARCHAR(20) NOT NULL DEFAULT 'open',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   resolved_at TIMESTAMPTZ
 );

 CREATE TABLE IF NOT EXISTS deposits(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id),
   amount BIGINT NOT NULL CHECK(amount>0),
   transfer_code VARCHAR(80) UNIQUE NOT NULL,
   provider_ref TEXT UNIQUE,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   created_at TIMESTAMPTZ DEFAULT NOW(), paid_at TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS withdrawals(
   id BIGSERIAL PRIMARY KEY,
   seller_id BIGINT NOT NULL REFERENCES users(id),
   amount BIGINT NOT NULL CHECK(amount>0),
   bank TEXT NOT NULL, account_no TEXT NOT NULL, account_name TEXT NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ
 );

 CREATE TABLE IF NOT EXISTS chats(
   id BIGSERIAL PRIMARY KEY,
   thread_key TEXT NOT NULL,
   sender_id BIGINT NOT NULL REFERENCES users(id),
   recipient_id BIGINT NOT NULL REFERENCES users(id),
   product_id BIGINT,
   channel VARCHAR(20) NOT NULL DEFAULT 'direct',
   message TEXT NOT NULL,
   read_at TIMESTAMPTZ,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 ALTER TABLE chats ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'direct';
 ALTER TABLE chats ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

 CREATE TABLE IF NOT EXISTS auctions(
   id BIGSERIAL PRIMARY KEY,
   seller_id BIGINT NOT NULL REFERENCES users(id),
   game VARCHAR(30) NOT NULL,
   title VARCHAR(160) NOT NULL,
   description TEXT NOT NULL,
   image TEXT,
   account_login TEXT NOT NULL,
   account_password TEXT NOT NULL,
   start_price BIGINT NOT NULL CHECK(start_price>0),
   bid_step BIGINT NOT NULL CHECK(bid_step>0),
   current_price BIGINT NOT NULL CHECK(current_price>0),
   current_bidder BIGINT REFERENCES users(id),
   ends_at TIMESTAMPTZ NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS auction_bids(
   id BIGSERIAL PRIMARY KEY,
   auction_id BIGINT NOT NULL REFERENCES auctions(id),
   bidder_id BIGINT NOT NULL REFERENCES users(id),
   amount BIGINT NOT NULL,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );

 CREATE TABLE IF NOT EXISTS wallet_ledger(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id),
   kind VARCHAR(50) NOT NULL,
   amount BIGINT NOT NULL,
   ref_type VARCHAR(50) DEFAULT '',
   ref_id VARCHAR(80) DEFAULT '',
   note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );

 CREATE TABLE IF NOT EXISTS audit_logs(
   id BIGSERIAL PRIMARY KEY,
   actor_id BIGINT REFERENCES users(id),
   action VARCHAR(100) NOT NULL,
   target_type VARCHAR(50) DEFAULT '',
   target_id VARCHAR(80) DEFAULT '',
   meta JSONB DEFAULT '{}'::jsonb,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );

 CREATE TABLE IF NOT EXISTS ip_bans(
   id BIGSERIAL PRIMARY KEY,
   ip VARCHAR(120) UNIQUE NOT NULL,
   reason TEXT DEFAULT '',
   created_by BIGINT REFERENCES users(id),
   created_at TIMESTAMPTZ DEFAULT NOW(),
   expires_at TIMESTAMPTZ
 );

 CREATE TABLE IF NOT EXISTS password_resets(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   token_hash TEXT NOT NULL,
   expires_at TIMESTAMPTZ NOT NULL,
   used_at TIMESTAMPTZ,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );

 CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
 CREATE INDEX IF NOT EXISTS idx_orders_release ON orders(release_status,hold_until);
 CREATE INDEX IF NOT EXISTS idx_chats_recipient ON chats(recipient_id,read_at);
 CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status,ends_at);
 `);

 const email=(process.env.ADMIN_EMAIL||'').toLowerCase();
 const pass=process.env.ADMIN_PASSWORD||'';
 if(email && pass.length>=12){
   const q=await pool.query(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
   if(!q.rowCount){
     const hash=await bcrypt.hash(pass,12);
     await pool.query(`INSERT INTO users(username,email,password_hash,role,seller_verification) VALUES('admin',$1,$2,'admin','verified')`,[email,hash]);
     console.log('Admin account created.');
   }
 }
}

async function releaseMatured(){
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const q=await c.query(`SELECT id,seller_id,seller_net FROM orders WHERE release_status='held' AND hold_until<=NOW() FOR UPDATE SKIP LOCKED`);
   for(const o of q.rows){
     await c.query(`UPDATE users SET held_balance=GREATEST(held_balance-$1,0),seller_balance=seller_balance+$1 WHERE id=$2`,[o.seller_net,o.seller_id]);
     await c.query(`UPDATE orders SET release_status='released',released_at=NOW() WHERE id=$1`,[o.id]);
     await ledger(c,o.seller_id,'HOLD_RELEASE',Number(o.seller_net),'order',o.id,'Tiền đơn hàng được mở khóa sau 72 giờ');
   }
   await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');console.error('releaseMatured',e.message)}finally{c.release()}
}

function sign(u){return jwt.sign({id:u.id,role:u.role},JWT_SECRET,{expiresIn:'12h'})}
function session(res,u){res.cookie('tg_session',sign(u),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:12*60*60*1000})}
async function auth(req,res,next){
 try{
   if(await isIpBanned(ipOf(req)))return res.status(403).json({error:'Địa chỉ mạng này đang bị chặn do vi phạm hoặc hành vi bất thường.'});
   const t=req.cookies.tg_session;
   if(!t)return res.status(401).json({error:'Bạn chưa đăng nhập'});
   const p=jwt.verify(t,JWT_SECRET);
   const q=await pool.query(`SELECT id,username,email,role,status,phone,seller_verification,balance,seller_balance,held_balance,created_at FROM users WHERE id=$1`,[p.id]);
   if(!q.rowCount)return res.status(401).json({error:'Phiên đăng nhập không hợp lệ'});
   if(q.rows[0].status!=='active')return res.status(403).json({error:'Tài khoản đang bị khóa'});
   req.user=q.rows[0];next();
 }catch{return res.status(401).json({error:'Phiên đăng nhập đã hết hạn'})}
}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Không có quyền quản trị'});next()}
function seller(req,res,next){if(!['seller','admin'].includes(req.user?.role))return res.status(403).json({error:'Tài khoản chưa được duyệt bán hàng'});next()}

app.use('/uploads',express.static(uploadsDir));
app.use(express.static(path.join(__dirname,'public')));

app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,version:'FINAL-BLUE-PRO'})}catch{res.status(500).json({ok:false})}});
app.get('/api/config',(req,res)=>res.json({
  bank:{name:BANK_NAME,account:BANK_ACCOUNT,accountName:BANK_ACCOUNT_NAME},
  support:{telegram:'tungtungsas',phone:'0876148544',facebook:'https://www.facebook.com/share/19LX5nekKj/?mibextid=wwXIfr'}
}));

app.post('/api/auth/register',authLimiter,async(req,res)=>{
 const ip=ipOf(req); if(await isIpBanned(ip))return res.status(403).json({error:'Địa chỉ mạng đang bị chặn'});
 const username=String(req.body.username||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
 if(!/^[a-zA-Z0-9_]{4,40}$/.test(username)||!email.includes('@')||password.length<8)return res.status(400).json({error:'Thông tin đăng ký chưa hợp lệ'});
 try{
   const hash=await bcrypt.hash(password,12);
   const q=await pool.query(`INSERT INTO users(username,email,password_hash,register_ip,last_login_ip) VALUES($1,$2,$3,$4,$4) RETURNING id,username,email,role,balance`,[username,email,hash,ip]);
   session(res,q.rows[0]);res.json(q.rows[0]);
 }catch{return res.status(409).json({error:'Tên đăng nhập hoặc email đã tồn tại'})}
});
app.post('/api/auth/login',authLimiter,async(req,res)=>{
 const ip=ipOf(req); if(await isIpBanned(ip))return res.status(403).json({error:'Địa chỉ mạng đang bị chặn'});
 const identity=String(req.body.identity||'').trim(),password=String(req.body.password||'');
 const q=await pool.query(`SELECT * FROM users WHERE username=$1 OR email=$2`,[identity,identity.toLowerCase()]);
 const u=q.rows[0];
 if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Sai tài khoản hoặc mật khẩu'});
 if(u.status!=='active')return res.status(403).json({error:'Tài khoản đang bị khóa'});
 await pool.query(`UPDATE users SET last_login_ip=$1 WHERE id=$2`,[ip,u.id]);
 session(res,u);
 res.json({ok:true,role:u.role,redirect:u.role==='admin'?'/admin.html':u.role==='seller'?'/seller.html':'/account.html'});
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('tg_session');res.json({ok:true})});
app.get('/api/me',auth,async(req,res)=>{await releaseMatured();res.json(req.user)});

app.get('/api/seller/status',auth,async(req,res)=>{
 const q=await pool.query(`SELECT id,status,admin_note,accepted_rules,created_at FROM seller_applications WHERE user_id=$1`,[req.user.id]);res.json(q.rows[0]||null);
});
app.post('/api/seller/apply',auth,upload.fields([{name:'cccd_front',maxCount:1},{name:'cccd_back',maxCount:1}]),async(req,res)=>{
 if(req.user.role!=='member')return res.status(400).json({error:'Tài khoản này không thể đăng ký seller'});
 if(String(req.body.accept_rules)!=='true')return res.status(400).json({error:'Bạn phải đọc và đồng ý quy định dành cho người bán'});
 const fullName=String(req.body.full_name||'').trim(),phone=String(req.body.phone||'').trim();
 if(!fullName||!phone||!req.files?.cccd_front?.[0]||!req.files?.cccd_back?.[0])return res.status(400).json({error:'Thiếu hồ sơ người bán'});
 try{
   await pool.query(`INSERT INTO seller_applications(user_id,full_name,phone,cccd_front,cccd_back,accepted_rules) VALUES($1,$2,$3,$4,$5,TRUE)`,
     [req.user.id,fullName,phone,req.files.cccd_front[0].filename,req.files.cccd_back[0].filename]);
   await pool.query(`UPDATE users SET seller_verification='pending' WHERE id=$1`,[req.user.id]);
   res.json({ok:true});
 }catch{return res.status(409).json({error:'Bạn đã gửi hồ sơ trước đó'})}
});

app.get('/api/products',async(req,res)=>{
 const vals=[];let where=`p.status='approved' AND u.status='active'`;
 if(req.query.game){vals.push(req.query.game);where+=` AND p.game=$${vals.length}`}
 const q=await pool.query(`SELECT p.id,p.game,p.title,p.description,p.price,p.image,p.warranty_days,p.created_at,u.id seller_id,u.username seller
 FROM products p JOIN users u ON u.id=p.seller_id WHERE ${where} ORDER BY p.id DESC`,vals);res.json(q.rows);
});
app.post('/api/products',auth,seller,upload.single('image'),async(req,res)=>{
 const {game,title,description,account_login,account_password}=req.body,price=Number(req.body.price),warranty=Number(req.body.warranty_days||3);
 if(!['lienquan','freefire','pubg','khac'].includes(game)||!title||!description||!account_login||!account_password||!Number.isInteger(price)||price<=0)return res.status(400).json({error:'Thông tin acc chưa hợp lệ'});
 const q=await pool.query(`INSERT INTO products(seller_id,game,title,description,price,image,account_login,account_password,warranty_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status`,
 [req.user.id,game,title,description,price,req.file?.filename||null,account_login,account_password,Math.max(0,Math.min(365,warranty))]);
 res.json(q.rows[0]);
});

app.post('/api/orders/:id/buy',auth,async(req,res)=>{
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const b=(await c.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`,[req.user.id])).rows[0];
  const p=(await c.query(`SELECT * FROM products WHERE id=$1 AND status='approved' FOR UPDATE`,[Number(req.params.id)])).rows[0];
  if(!p)throw Error('Acc không tồn tại hoặc đã bán');
  if(Number(p.seller_id)===Number(b.id))throw Error('Không thể mua acc của chính mình');
  if(Number(b.balance)<Number(p.price))throw Error('Số dư không đủ');
  const fee=Math.round(Number(p.price)*FEE/100),net=Number(p.price)-fee;
  await c.query(`UPDATE users SET balance=balance-$1 WHERE id=$2`,[p.price,b.id]);
  await c.query(`UPDATE users SET held_balance=held_balance+$1 WHERE id=$2`,[net,p.seller_id]);
  const o=await c.query(`INSERT INTO orders(buyer_id,seller_id,product_id,amount,fee,seller_net,release_status,hold_until) VALUES($1,$2,$3,$4,$5,$6,'held',NOW()+INTERVAL '72 hours') RETURNING id,hold_until`,
    [b.id,p.seller_id,p.id,p.price,fee,net]);
  await c.query(`UPDATE products SET status='sold' WHERE id=$1`,[p.id]);
  await ledger(c,b.id,'BUY',-Number(p.price),'order',o.rows[0].id,'Mua acc');
  await ledger(c,p.seller_id,'HOLD_IN',net,'order',o.rows[0].id,'Tiền tạm giữ 72 giờ');
  await audit(c,b.id,'BUY_PRODUCT','product',p.id,{order:o.rows[0].id});
  await c.query('COMMIT');
  res.json({ok:true,order_id:o.rows[0].id,account:p.account_login,password:p.account_password,hold_until:o.rows[0].hold_until});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/orders/mine',auth,async(req,res)=>{
 await releaseMatured();
 const q=await pool.query(`SELECT o.id,o.amount,o.fee,o.seller_net,o.status,o.release_status,o.hold_until,o.created_at,p.title,p.game,p.warranty_days,
 CASE WHEN o.buyer_id=$1 THEN p.account_login END account_login,
 CASE WHEN o.buyer_id=$1 THEN p.account_password END account_password,
 CASE WHEN o.buyer_id=$1 THEN 'buyer' ELSE 'seller' END relation
 FROM orders o JOIN products p ON p.id=o.product_id WHERE o.buyer_id=$1 OR o.seller_id=$1 ORDER BY o.id DESC`,[req.user.id]);res.json(q.rows);
});

app.post('/api/complaints',auth,async(req,res)=>{
 const orderId=Number(req.body.order_id),type=String(req.body.type||'other').slice(0,50),description=String(req.body.description||'').trim().slice(0,3000);
 if(!orderId||!description)return res.status(400).json({error:'Thiếu nội dung khiếu nại'});
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const o=(await c.query(`SELECT * FROM orders WHERE id=$1 AND buyer_id=$2 FOR UPDATE`,[orderId,req.user.id])).rows[0];
   if(!o)throw Error('Không tìm thấy đơn hàng');
   const exists=await c.query(`SELECT 1 FROM complaints WHERE order_id=$1 AND status='open'`,[orderId]);
   if(exists.rowCount)throw Error('Đơn hàng đã có khiếu nại đang xử lý');
   await c.query(`UPDATE orders SET release_status='disputed' WHERE id=$1 AND release_status='held'`,[orderId]);
   const x=await c.query(`INSERT INTO complaints(order_id,buyer_id,seller_id,type,description,evidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orderId,req.user.id,o.seller_id,type,description,String(req.body.evidence||'').slice(0,1200)]);
   await audit(c,req.user.id,'OPEN_COMPLAINT','order',orderId,{complaint:x.rows[0].id});
   await c.query('COMMIT');res.json({ok:true,id:x.rows[0].id});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});

app.post('/api/deposits',auth,async(req,res)=>{
 const amount=Number(req.body.amount);if(!Number.isInteger(amount)||amount<10000)return res.status(400).json({error:'Số tiền nạp tối thiểu 10.000đ'});
 const code='TG'+req.user.id+Date.now().toString().slice(-8);
 const q=await pool.query(`INSERT INTO deposits(user_id,amount,transfer_code) VALUES($1,$2,$3) RETURNING *`,[req.user.id,amount,code]);
 res.json({...q.rows[0],bank:{name:BANK_NAME,account:BANK_ACCOUNT,accountName:BANK_ACCOUNT_NAME}});
});
app.get('/api/deposits/mine',auth,async(req,res)=>res.json((await pool.query(`SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC`,[req.user.id])).rows));
app.post('/api/payments/webhook',async(req,res)=>{
 if(!process.env.PAYMENT_WEBHOOK_SECRET||req.headers['x-webhook-secret']!==process.env.PAYMENT_WEBHOOK_SECRET)return res.status(401).json({error:'Webhook không hợp lệ'});
 if(req.body.status!=='paid')return res.json({ok:true});
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const d=(await c.query(`SELECT * FROM deposits WHERE transfer_code=$1 FOR UPDATE`,[req.body.transfer_code])).rows[0];
   if(!d||d.status==='paid'){await c.query('ROLLBACK');return res.json({ok:true})}
   if(!req.body.provider_ref)throw Error('Thiếu mã giao dịch');
   const dup=await c.query(`SELECT 1 FROM deposits WHERE provider_ref=$1`,[String(req.body.provider_ref)]);
   if(dup.rowCount)throw Error('Giao dịch đã được xử lý');
   await c.query(`UPDATE deposits SET status='paid',provider_ref=$1,paid_at=NOW() WHERE id=$2`,[String(req.body.provider_ref),d.id]);
   await c.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`,[d.amount,d.user_id]);
   await ledger(c,d.user_id,'DEPOSIT',Number(d.amount),'deposit',d.id,'Nạp tiền xác nhận qua webhook');
   await c.query('COMMIT');res.json({ok:true});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});

app.post('/api/withdrawals',auth,seller,async(req,res)=>{
 await releaseMatured();
 const amount=Number(req.body.amount),bank=String(req.body.bank||''),no=String(req.body.account_no||''),name=String(req.body.account_name||'');
 if(!Number.isInteger(amount)||amount<10000||!bank||!no||!name)return res.status(400).json({error:'Thông tin rút tiền chưa hợp lệ'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const u=(await c.query(`SELECT seller_balance FROM users WHERE id=$1 FOR UPDATE`,[req.user.id])).rows[0];
  if(Number(u.seller_balance)<amount)throw Error('Số dư có thể rút không đủ');
  await c.query(`UPDATE users SET seller_balance=seller_balance-$1 WHERE id=$2`,[amount,req.user.id]);
  const w=await c.query(`INSERT INTO withdrawals(seller_id,amount,bank,account_no,account_name) VALUES($1,$2,$3,$4,$5) RETURNING id,status`,[req.user.id,amount,bank,no,name]);
  await ledger(c,req.user.id,'WITHDRAW_HOLD',-amount,'withdrawal',w.rows[0].id,'Yêu cầu rút tiền');
  await c.query('COMMIT');res.json(w.rows[0]);
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});

app.get('/api/admin-id',auth,async(req,res)=>{
 const q=await pool.query(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`);res.json({id:q.rows[0]?.id||null});
});
app.get('/api/chat',auth,async(req,res)=>{
 const other=Number(req.query.with),product=Number(req.query.product||0),channel=String(req.query.channel||'direct');
 if(!other)return res.status(400).json({error:'Thiếu người nhận'});
 const ids=[req.user.id,other].sort((a,b)=>a-b),key=`${channel}:u:${ids[0]}:${ids[1]}:p:${product}`;
 await pool.query(`UPDATE chats SET read_at=NOW() WHERE thread_key=$1 AND recipient_id=$2 AND read_at IS NULL`,[key,req.user.id]);
 res.json((await pool.query(`SELECT c.*,u.username sender FROM chats c JOIN users u ON u.id=c.sender_id WHERE thread_key=$1 ORDER BY c.id ASC LIMIT 500`,[key])).rows);
});
app.post('/api/chat',auth,async(req,res)=>{
 const other=Number(req.body.to),product=Number(req.body.product||0),channel=String(req.body.channel||'direct').slice(0,20),message=String(req.body.message||'').trim().slice(0,1800);
 if(!other||!message)return res.status(400).json({error:'Tin nhắn chưa hợp lệ'});
 const ids=[req.user.id,other].sort((a,b)=>a-b),key=`${channel}:u:${ids[0]}:${ids[1]}:p:${product}`;
 await pool.query(`INSERT INTO chats(thread_key,sender_id,recipient_id,product_id,channel,message) VALUES($1,$2,$3,$4,$5,$6)`,[key,req.user.id,other,product||null,channel,message]);
 res.json({ok:true});
});

app.get('/api/auctions',async(req,res)=>{
 await pool.query(`UPDATE auctions SET status='ended' WHERE status='approved' AND ends_at<=NOW()`);
 res.json((await pool.query(`SELECT a.id,a.game,a.title,a.description,a.image,a.start_price,a.bid_step,a.current_price,a.current_bidder,a.ends_at,a.status,u.username seller FROM auctions a JOIN users u ON u.id=a.seller_id WHERE a.status='approved' AND a.ends_at>NOW() ORDER BY a.ends_at ASC`)).rows);
});
app.post('/api/auctions',auth,seller,upload.single('image'),async(req,res)=>{
 const start=Number(req.body.start_price),step=Number(req.body.bid_step),hours=Number(req.body.hours||24);
 if(!req.body.title||!req.body.description||!req.body.account_login||!req.body.account_password||start<=0||step<=0||hours<1||hours>168)return res.status(400).json({error:'Thông tin đấu giá chưa hợp lệ'});
 const q=await pool.query(`INSERT INTO auctions(seller_id,game,title,description,image,account_login,account_password,start_price,bid_step,current_price,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,NOW()+($10||' hours')::interval) RETURNING id,status`,
 [req.user.id,req.body.game||'khac',req.body.title,req.body.description,req.file?.filename||null,req.body.account_login,req.body.account_password,start,step,String(hours)]);
 res.json(q.rows[0]);
});
app.post('/api/auctions/:id/bid',auth,async(req,res)=>{
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const a=(await c.query(`SELECT * FROM auctions WHERE id=$1 AND status='approved' AND ends_at>NOW() FOR UPDATE`,[req.params.id])).rows[0];
   if(!a)throw Error('Phiên đấu giá đã kết thúc hoặc chưa được duyệt');
   if(Number(a.seller_id)===Number(req.user.id))throw Error('Không thể tự trả giá acc của mình');
   const min=Number(a.current_price)+Number(a.bid_step),amount=Number(req.body.amount);
   if(!Number.isInteger(amount)||amount<min)throw Error('Giá trả tối thiểu là '+min.toLocaleString('vi-VN')+'đ');
   await c.query(`INSERT INTO auction_bids(auction_id,bidder_id,amount) VALUES($1,$2,$3)`,[a.id,req.user.id,amount]);
   await c.query(`UPDATE auctions SET current_price=$1,current_bidder=$2 WHERE id=$3`,[amount,req.user.id,a.id]);
   await c.query('COMMIT');res.json({ok:true,current_price:amount});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});

/* ADMIN */
app.get('/api/admin/stats',auth,admin,async(req,res)=>{
 await releaseMatured();
 const [u,s,p,o,h,c]=await Promise.all([
   pool.query(`SELECT COUNT(*) c FROM users`),pool.query(`SELECT COUNT(*) c FROM users WHERE role='seller'`),
   pool.query(`SELECT COUNT(*) c FROM products WHERE status='approved'`),pool.query(`SELECT COUNT(*) c FROM orders`),
   pool.query(`SELECT COALESCE(SUM(held_balance),0) v FROM users`),pool.query(`SELECT COUNT(*) c FROM complaints WHERE status='open'`)
 ]);
 res.json({users:Number(u.rows[0].c),sellers:Number(s.rows[0].c),products:Number(p.rows[0].c),orders:Number(o.rows[0].c),held:Number(h.rows[0].v),complaints:Number(c.rows[0].c)});
});
app.get('/api/admin/users',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT id,username,email,role,status,balance,seller_balance,held_balance,register_ip,last_login_ip,created_at FROM users ORDER BY id DESC LIMIT 500`)).rows));
app.post('/api/admin/users/:id/toggle-lock',auth,admin,async(req,res)=>{
 const q=await pool.query(`SELECT role,status FROM users WHERE id=$1`,[req.params.id]);if(!q.rowCount||q.rows[0].role==='admin')return res.status(400).json({error:'Không thể thực hiện'});
 const status=q.rows[0].status==='active'?'suspended':'active';await pool.query(`UPDATE users SET status=$1 WHERE id=$2`,[status,req.params.id]);res.json({ok:true,status});
});
app.post('/api/admin/users/:id/reset-password',auth,admin,async(req,res)=>{
 const password=String(req.body.password||'');if(password.length<8)return res.status(400).json({error:'Mật khẩu mới tối thiểu 8 ký tự'});
 const q=await pool.query(`SELECT role FROM users WHERE id=$1`,[req.params.id]);if(!q.rowCount||q.rows[0].role==='admin')return res.status(400).json({error:'Không thể thực hiện'});
 const hash=await bcrypt.hash(password,12);await pool.query(`UPDATE users SET password_hash=$1 WHERE id=$2`,[hash,req.params.id]);
 await pool.query(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,meta) VALUES($1,'RESET_PASSWORD','user',$2,'{}')`,[req.user.id,String(req.params.id)]);
 res.json({ok:true});
});
app.delete('/api/admin/users/:id',auth,admin,async(req,res)=>{
 const id=Number(req.params.id);
 const q=await pool.query(`SELECT role FROM users WHERE id=$1`,[id]);if(!q.rowCount||q.rows[0].role==='admin')return res.status(400).json({error:'Không thể xóa tài khoản này'});
 const refs=await pool.query(`SELECT (SELECT COUNT(*) FROM orders WHERE buyer_id=$1 OR seller_id=$1)+(SELECT COUNT(*) FROM deposits WHERE user_id=$1)+(SELECT COUNT(*) FROM withdrawals WHERE seller_id=$1) c`,[id]);
 if(Number(refs.rows[0].c)>0)return res.status(400).json({error:'Tài khoản đã có giao dịch. Hãy khóa thay vì xóa để giữ lịch sử.'});
 await pool.query(`DELETE FROM seller_applications WHERE user_id=$1`,[id]);await pool.query(`DELETE FROM users WHERE id=$1`,[id]);res.json({ok:true});
});
app.post('/api/admin/ip-ban',auth,admin,async(req,res)=>{
 const ip=String(req.body.ip||'').trim().slice(0,120);if(!ip)return res.status(400).json({error:'Thiếu IP'});
 await pool.query(`INSERT INTO ip_bans(ip,reason,created_by) VALUES($1,$2,$3) ON CONFLICT(ip) DO UPDATE SET reason=EXCLUDED.reason,created_by=EXCLUDED.created_by,expires_at=NULL`,[ip,String(req.body.reason||'Vi phạm'),req.user.id]);res.json({ok:true});
});
app.get('/api/admin/seller-applications',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT a.*,u.username,u.email FROM seller_applications a JOIN users u ON u.id=a.user_id WHERE a.status='pending' ORDER BY a.id`)).rows));
app.post('/api/admin/seller-applications/:id/approve',auth,admin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const a=(await c.query(`SELECT * FROM seller_applications WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!a||!a.accepted_rules)throw Error('Hồ sơ không hợp lệ');await c.query(`UPDATE seller_applications SET status='approved',updated_at=NOW() WHERE id=$1`,[a.id]);await c.query(`UPDATE users SET role='seller',seller_verification='verified' WHERE id=$1`,[a.user_id]);await audit(c,req.user.id,'APPROVE_SELLER','user',a.user_id,{});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.post('/api/admin/seller-applications/:id/reject',auth,admin,async(req,res)=>{
 const a=(await pool.query(`SELECT * FROM seller_applications WHERE id=$1`,[req.params.id])).rows[0];if(!a)return res.status(404).json({error:'Không tìm thấy'});
 await pool.query(`UPDATE seller_applications SET status='rejected',admin_note=$1,updated_at=NOW() WHERE id=$2`,[String(req.body.note||''),a.id]);await pool.query(`UPDATE users SET seller_verification='rejected' WHERE id=$1`,[a.user_id]);res.json({ok:true});
});
app.get('/api/admin/products',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT p.id,p.title,p.game,p.price,p.status,p.created_at,u.username seller FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC LIMIT 500`)).rows));
app.post('/api/admin/products/:id/approve',auth,admin,async(req,res)=>{await pool.query(`UPDATE products SET status='approved' WHERE id=$1 AND status='pending'`,[req.params.id]);res.json({ok:true})});
app.post('/api/admin/products/:id/reject',auth,admin,async(req,res)=>{await pool.query(`UPDATE products SET status='rejected',admin_note=$1 WHERE id=$2 AND status='pending'`,[String(req.body.note||''),req.params.id]);res.json({ok:true})});
app.get('/api/admin/complaints',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT c.*,b.username buyer,s.username seller,p.title FROM complaints c JOIN users b ON b.id=c.buyer_id JOIN users s ON s.id=c.seller_id JOIN orders o ON o.id=c.order_id JOIN products p ON p.id=o.product_id ORDER BY c.id DESC`)).rows));
app.post('/api/admin/complaints/:id/resolve',auth,admin,async(req,res)=>{
 const decision=String(req.body.decision||''); if(!['seller','refund'].includes(decision))return res.status(400).json({error:'Quyết định không hợp lệ'});
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const cp=(await c.query(`SELECT c.*,o.seller_net,o.amount,o.release_status FROM complaints c JOIN orders o ON o.id=c.order_id WHERE c.id=$1 FOR UPDATE`,[req.params.id])).rows[0];
   if(!cp||cp.status!=='open')throw Error('Khiếu nại không hợp lệ');
   if(decision==='seller'){
     if(cp.release_status!=='released'){
       await c.query(`UPDATE users SET held_balance=GREATEST(held_balance-$1,0),seller_balance=seller_balance+$1 WHERE id=$2`,[cp.seller_net,cp.seller_id]);
       await c.query(`UPDATE orders SET release_status='released',released_at=NOW() WHERE id=$1`,[cp.order_id]);
     }
   }else{
     await c.query(`UPDATE users SET held_balance=GREATEST(held_balance-$1,0) WHERE id=$2`,[cp.seller_net,cp.seller_id]);
     await c.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`,[cp.amount,cp.buyer_id]);
     await c.query(`UPDATE orders SET release_status='refunded',status='refunded' WHERE id=$1`,[cp.order_id]);
     await ledger(c,cp.buyer_id,'REFUND',Number(cp.amount),'order',cp.order_id,'Hoàn tiền khiếu nại');
   }
   await c.query(`UPDATE complaints SET status='resolved',admin_note=$1,resolved_at=NOW() WHERE id=$2`,[String(req.body.note||''),cp.id]);
   await audit(c,req.user.id,'RESOLVE_COMPLAINT','complaint',cp.id,{decision});
   await c.query('COMMIT');res.json({ok:true});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/admin/deposits',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT d.*,u.username FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 500`)).rows));
app.post('/api/admin/deposits/:id/approve',auth,admin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const d=(await c.query(`SELECT * FROM deposits WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!d||d.status!=='pending')throw Error('Giao dịch không hợp lệ');await c.query(`UPDATE deposits SET status='paid',provider_ref=$1,paid_at=NOW() WHERE id=$2`,['ADMIN-'+Date.now(),d.id]);await c.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`,[d.amount,d.user_id]);await ledger(c,d.user_id,'DEPOSIT',Number(d.amount),'deposit',d.id,'Admin xác nhận tiền vào');await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/admin/withdrawals',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT w.*,u.username FROM withdrawals w JOIN users u ON u.id=w.seller_id ORDER BY w.id DESC LIMIT 500`)).rows));
app.post('/api/admin/withdrawals/:id/approve',auth,admin,async(req,res)=>{const q=await pool.query(`UPDATE withdrawals SET status='paid',processed_at=NOW(),admin_note=$1 WHERE id=$2 AND status='pending' RETURNING *`,[String(req.body.note||''),req.params.id]);if(!q.rowCount)return res.status(400).json({error:'Yêu cầu không hợp lệ'});res.json({ok:true})});
app.post('/api/admin/withdrawals/:id/reject',auth,admin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const w=(await c.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!w||w.status!=='pending')throw Error('Yêu cầu không hợp lệ');await c.query(`UPDATE withdrawals SET status='rejected',processed_at=NOW(),admin_note=$1 WHERE id=$2`,[String(req.body.note||''),w.id]);await c.query(`UPDATE users SET seller_balance=seller_balance+$1 WHERE id=$2`,[w.amount,w.seller_id]);await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/admin/auctions',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT a.*,u.username seller FROM auctions a JOIN users u ON u.id=a.seller_id ORDER BY a.id DESC LIMIT 300`)).rows));
app.post('/api/admin/auctions/:id/approve',auth,admin,async(req,res)=>{await pool.query(`UPDATE auctions SET status='approved' WHERE id=$1 AND status='pending'`,[req.params.id]);res.json({ok:true})});
app.post('/api/admin/auctions/:id/cancel',auth,admin,async(req,res)=>{await pool.query(`UPDATE auctions SET status='cancelled' WHERE id=$1 AND status IN ('pending','approved')`,[req.params.id]);res.json({ok:true})});
app.get('/api/admin/audit',auth,admin,async(req,res)=>res.json((await pool.query(`SELECT a.*,u.username actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 500`)).rows));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(async()=>{
 await releaseMatured();
 setInterval(releaseMatured,10*60*1000).unref();
 
// BLUE PRO UPGRADE: IP ban management
app.get('/api/admin/ip-bans',auth,admin,async(req,res)=>{
  const q=await pool.query(`SELECT b.id,b.ip,b.reason,b.created_at,b.expires_at,u.username created_by_name
    FROM ip_bans b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.created_at DESC`);
  res.json(q.rows);
});
app.delete('/api/admin/ip-bans/:id',auth,admin,async(req,res)=>{
  const q=await pool.query(`DELETE FROM ip_bans WHERE id=$1 RETURNING id,ip`,[req.params.id]);
  if(!q.rowCount)return res.status(404).json({error:'Không tìm thấy IP bị chặn'});
  await audit(pool,req.user.id,'ip_unban','ip',q.rows[0].ip,{});
  res.json({ok:true,ip:q.rows[0].ip});
});

// BLUE PRO UPGRADE: persistent Admin support inbox
app.get('/api/admin/support-threads',auth,admin,async(req,res)=>{
  const q=await pool.query(`SELECT c.thread_key,
    MAX(c.created_at) last_message_at,
    COUNT(*) FILTER (WHERE c.recipient_id=$1 AND c.read_at IS NULL) unread,
    MAX(CASE WHEN c.sender_id<>$1 THEN c.sender_id WHEN c.recipient_id<>$1 THEN c.recipient_id END) other_id,
    MAX(CASE WHEN c.sender_id<>$1 THEN su.username WHEN c.recipient_id<>$1 THEN ru.username END) username
    FROM chats c
    JOIN users su ON su.id=c.sender_id JOIN users ru ON ru.id=c.recipient_id
    WHERE c.channel='support' AND (c.sender_id=$1 OR c.recipient_id=$1)
    GROUP BY c.thread_key ORDER BY last_message_at DESC`,[req.user.id]);
  res.json(q.rows);
});

app.listen(PORT,'0.0.0.0',()=>console.log(`TAPHOAGAME FINAL BLUE PRO running on ${PORT}`));
}).catch(e=>{console.error('Startup failed:',e);process.exit(1)});
