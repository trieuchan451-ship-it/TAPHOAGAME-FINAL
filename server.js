
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
const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL;
const JWT_SECRET=process.env.JWT_SECRET;
const FEE=Number(process.env.SHOP_FEE_PERCENT||5);

if(!DATABASE_URL){console.error('DATABASE_URL is required');process.exit(1)}
if(!JWT_SECRET || JWT_SECRET.length<32){console.error('JWT_SECRET must be at least 32 characters');process.exit(1)}

const pool=new Pool({
  connectionString:DATABASE_URL,
  ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,
  max:10,
  idleTimeoutMillis:30000
});

const uploadsDir=path.join(__dirname,'uploads');
fs.mkdirSync(uploadsDir,{recursive:true});
const upload=multer({
  dest:uploadsDir,
  limits:{fileSize:5*1024*1024,files:2},
  fileFilter:(req,file,cb)=>{
    if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype)) return cb(new Error('Chỉ nhận JPG/PNG/WEBP'));
    cb(null,true);
  }
});

app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(rateLimit({windowMs:60_000,max:180,standardHeaders:true,legacyHeaders:false}));
app.use(express.json({limit:'512kb'}));
app.use(express.urlencoded({extended:false,limit:'512kb'}));
app.use(cookieParser());

const authLimiter=rateLimit({windowMs:15*60_000,max:15,message:{error:'Thử đăng nhập quá nhiều. Vui lòng thử lại sau.'}});

function audit(client,actorId,action,targetType,targetId,meta={}){
  return client.query(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,meta) VALUES($1,$2,$3,$4,$5)`,
    [actorId||null,action,targetType||'',targetId?String(targetId):'',JSON.stringify(meta)]);
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
   phone_verified BOOLEAN DEFAULT FALSE,
   device_verified BOOLEAN DEFAULT FALSE,
   seller_verification VARCHAR(20) DEFAULT 'none',
   balance BIGINT NOT NULL DEFAULT 0 CHECK(balance>=0),
   seller_balance BIGINT NOT NULL DEFAULT 0 CHECK(seller_balance>=0),
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS seller_applications(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   full_name TEXT NOT NULL,
   phone TEXT NOT NULL,
   cccd_front TEXT NOT NULL,
   cccd_back TEXT NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   updated_at TIMESTAMPTZ DEFAULT NOW()
 );
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
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS orders(
   id BIGSERIAL PRIMARY KEY,
   buyer_id BIGINT NOT NULL REFERENCES users(id),
   seller_id BIGINT NOT NULL REFERENCES users(id),
   product_id BIGINT NOT NULL REFERENCES products(id),
   amount BIGINT NOT NULL,
   fee BIGINT NOT NULL,
   seller_net BIGINT NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'paid',
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS deposits(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id),
   amount BIGINT NOT NULL CHECK(amount>0),
   transfer_code VARCHAR(80) UNIQUE NOT NULL,
   provider_ref TEXT UNIQUE,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   paid_at TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS withdrawals(
   id BIGSERIAL PRIMARY KEY,
   seller_id BIGINT NOT NULL REFERENCES users(id),
   amount BIGINT NOT NULL CHECK(amount>0),
   bank TEXT NOT NULL,
   account_no TEXT NOT NULL,
   account_name TEXT NOT NULL,
   status VARCHAR(20) NOT NULL DEFAULT 'pending',
   admin_note TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW(),
   processed_at TIMESTAMPTZ
 );
 CREATE TABLE IF NOT EXISTS chats(
   id BIGSERIAL PRIMARY KEY,
   thread_key TEXT NOT NULL,
   sender_id BIGINT NOT NULL REFERENCES users(id),
   recipient_id BIGINT NOT NULL REFERENCES users(id),
   product_id BIGINT,
   message TEXT NOT NULL,
   created_at TIMESTAMPTZ DEFAULT NOW()
 );
 CREATE TABLE IF NOT EXISTS password_resets(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   token_hash TEXT NOT NULL,
   expires_at TIMESTAMPTZ NOT NULL,
   used_at TIMESTAMPTZ,
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
 CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
 CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
 CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
 CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
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

function sign(u){return jwt.sign({id:u.id,role:u.role},JWT_SECRET,{expiresIn:'12h'})}
function setSession(res,u){res.cookie('tg_session',sign(u),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:12*60*60*1000})}
async function auth(req,res,next){
 try{
   const t=req.cookies.tg_session;
   if(!t)return res.status(401).json({error:'Bạn chưa đăng nhập'});
   const p=jwt.verify(t,JWT_SECRET);
   const q=await pool.query(`SELECT id,username,email,role,status,phone,phone_verified,device_verified,seller_verification,balance,seller_balance,created_at FROM users WHERE id=$1`,[p.id]);
   if(!q.rowCount)return res.status(401).json({error:'Phiên đăng nhập không hợp lệ'});
   if(q.rows[0].status!=='active')return res.status(403).json({error:'Tài khoản đang bị khóa'});
   req.user=q.rows[0];next();
 }catch{return res.status(401).json({error:'Phiên đăng nhập hết hạn'})}
}
function onlyAdmin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Không có quyền Admin'});next()}
function onlySeller(req,res,next){if(!['seller','admin'].includes(req.user?.role))return res.status(403).json({error:'Tài khoản chưa được duyệt bán hàng'});next()}

app.use('/uploads',express.static(uploadsDir));
app.use(express.static(path.join(__dirname,'public')));

app.get('/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,app:'TAPHOAGAME_FINAL'})}catch{res.status(500).json({ok:false})}});
app.get('/api/config',(req,res)=>res.json({fee:FEE,bank:{name:process.env.BANK_NAME||'',account:process.env.BANK_ACCOUNT||'',accountName:process.env.BANK_ACCOUNT_NAME||''}}));

app.post('/api/auth/register',authLimiter,async(req,res)=>{
 const username=String(req.body.username||'').trim();
 const email=String(req.body.email||'').trim().toLowerCase();
 const password=String(req.body.password||'');
 if(!/^[a-zA-Z0-9_]{4,40}$/.test(username)||!email.includes('@')||password.length<8)return res.status(400).json({error:'Thông tin đăng ký không hợp lệ'});
 try{
   const hash=await bcrypt.hash(password,12);
   const q=await pool.query(`INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING id,username,email,role,status,balance,seller_balance`,[username,email,hash]);
   setSession(res,q.rows[0]);res.json(q.rows[0]);
 }catch{return res.status(409).json({error:'Tên đăng nhập hoặc email đã tồn tại'})}
});

app.post('/api/auth/login',authLimiter,async(req,res)=>{
 const identity=String(req.body.identity||'').trim();
 const password=String(req.body.password||'');
 const q=await pool.query(`SELECT * FROM users WHERE username=$1 OR email=$2`,[identity,identity.toLowerCase()]);
 const u=q.rows[0];
 if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Sai tài khoản hoặc mật khẩu'});
 if(u.status!=='active')return res.status(403).json({error:'Tài khoản đang bị khóa'});
 setSession(res,u);
 const redirect=u.role==='admin'?'/admin.html':u.role==='seller'?'/seller.html':'/account.html';
 res.json({ok:true,role:u.role,redirect});
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('tg_session');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json(req.user));

app.post('/api/auth/forgot',async(req,res)=>{
 const email=String(req.body.email||'').trim().toLowerCase();
 const q=await pool.query(`SELECT id,email FROM users WHERE email=$1`,[email]);
 if(!q.rowCount)return res.json({ok:true});
 if(!(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS))return res.status(503).json({error:'Email khôi phục chưa được cấu hình'});
 const token=crypto.randomBytes(32).toString('hex');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 await pool.query(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')`,[q.rows[0].id,hash]);
 const tr=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:String(process.env.SMTP_SECURE)==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
 const base=`${req.protocol}://${req.get('host')}`;
 await tr.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:email,subject:'Khôi phục mật khẩu TAPHOAGAME.VN',text:`Đặt lại mật khẩu: ${base}/reset.html?token=${token}`});
 res.json({ok:true});
});
app.post('/api/auth/reset',async(req,res)=>{
 const token=String(req.body.token||''),password=String(req.body.password||'');
 if(password.length<8)return res.status(400).json({error:'Mật khẩu tối thiểu 8 ký tự'});
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const q=await pool.query(`SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY id DESC LIMIT 1`,[hash]);
 if(!q.rowCount)return res.status(400).json({error:'Liên kết không hợp lệ hoặc hết hạn'});
 const ph=await bcrypt.hash(password,12);
 const c=await pool.connect();try{await c.query('BEGIN');await c.query(`UPDATE users SET password_hash=$1 WHERE id=$2`,[ph,q.rows[0].user_id]);await c.query(`UPDATE password_resets SET used_at=NOW() WHERE id=$1`,[q.rows[0].id]);await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
});

app.get('/api/seller/status',auth,async(req,res)=>{
 const q=await pool.query(`SELECT id,status,admin_note,created_at FROM seller_applications WHERE user_id=$1`,[req.user.id]);res.json(q.rows[0]||null);
});
app.post('/api/seller/apply',auth,upload.fields([{name:'cccd_front',maxCount:1},{name:'cccd_back',maxCount:1}]),async(req,res)=>{
 if(req.user.role!=='member')return res.status(400).json({error:'Tài khoản này không thể đăng ký'});
 const fullName=String(req.body.full_name||'').trim(),phone=String(req.body.phone||'').trim();
 if(!fullName||!phone||!req.files?.cccd_front?.[0]||!req.files?.cccd_back?.[0])return res.status(400).json({error:'Thiếu hồ sơ'});
 try{
   await pool.query(`INSERT INTO seller_applications(user_id,full_name,phone,cccd_front,cccd_back) VALUES($1,$2,$3,$4,$5)`,[req.user.id,fullName,phone,req.files.cccd_front[0].filename,req.files.cccd_back[0].filename]);
   await pool.query(`UPDATE users SET seller_verification='pending' WHERE id=$1`,[req.user.id]);res.json({ok:true});
 }catch{return res.status(409).json({error:'Bạn đã gửi hồ sơ'})}
});

app.get('/api/products',async(req,res)=>{
 const vals=[];let where=`p.status='approved' AND u.status='active'`;
 if(req.query.game){vals.push(req.query.game);where+=` AND p.game=$${vals.length}`}
 const q=await pool.query(`SELECT p.id,p.game,p.title,p.description,p.price,p.image,p.created_at,u.id seller_id,u.username seller FROM products p JOIN users u ON u.id=p.seller_id WHERE ${where} ORDER BY p.id DESC`,vals);
 res.json(q.rows);
});
app.post('/api/products',auth,onlySeller,upload.single('image'),async(req,res)=>{
 const {game,title,description,account_login,account_password}=req.body,price=Number(req.body.price);
 if(!['lienquan','freefire','pubg','khac'].includes(game)||!title||!description||!account_login||!account_password||!Number.isInteger(price)||price<=0)return res.status(400).json({error:'Thông tin acc không hợp lệ'});
 const q=await pool.query(`INSERT INTO products(seller_id,game,title,description,price,image,account_login,account_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status`,[req.user.id,game,title,description,price,req.file?.filename||null,account_login,account_password]);
 res.json(q.rows[0]);
});

app.post('/api/orders/:id/buy',auth,async(req,res)=>{
 const c=await pool.connect();
 try{
   await c.query('BEGIN');
   const buyer=(await c.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`,[req.user.id])).rows[0];
   const p=(await c.query(`SELECT * FROM products WHERE id=$1 AND status='approved' FOR UPDATE`,[Number(req.params.id)])).rows[0];
   if(!p)throw Error('Sản phẩm không tồn tại hoặc đã bán');
   if(Number(p.seller_id)===Number(buyer.id))throw Error('Không thể mua acc của chính mình');
   if(Number(buyer.balance)<Number(p.price))throw Error('Số dư không đủ');
   const fee=Math.round(Number(p.price)*FEE/100),net=Number(p.price)-fee;
   await c.query(`UPDATE users SET balance=balance-$1 WHERE id=$2`,[p.price,buyer.id]);
   await c.query(`UPDATE users SET seller_balance=seller_balance+$1 WHERE id=$2`,[net,p.seller_id]);
   const o=await c.query(`INSERT INTO orders(buyer_id,seller_id,product_id,amount,fee,seller_net) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[buyer.id,p.seller_id,p.id,p.price,fee,net]);
   await c.query(`UPDATE products SET status='sold' WHERE id=$1`,[p.id]);
   await audit(c,buyer.id,'BUY_PRODUCT','product',p.id,{order_id:o.rows[0].id,amount:Number(p.price),fee});
   await c.query('COMMIT');
   res.json({ok:true,order_id:o.rows[0].id,account:p.account_login,password:p.account_password});
 }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/orders/mine',auth,async(req,res)=>{
 const q=await pool.query(`SELECT o.id,o.amount,o.fee,o.seller_net,o.status,o.created_at,p.title,p.game,
 CASE WHEN o.buyer_id=$1 THEN p.account_login END account_login,
 CASE WHEN o.buyer_id=$1 THEN p.account_password END account_password,
 CASE WHEN o.buyer_id=$1 THEN 'buyer' ELSE 'seller' END relation
 FROM orders o JOIN products p ON p.id=o.product_id WHERE o.buyer_id=$1 OR o.seller_id=$1 ORDER BY o.id DESC`,[req.user.id]);res.json(q.rows);
});

app.post('/api/deposits',auth,async(req,res)=>{
 const amount=Number(req.body.amount);if(!Number.isInteger(amount)||amount<10000)return res.status(400).json({error:'Nạp tối thiểu 10.000đ'});
 const code='TG'+req.user.id+Date.now().toString().slice(-8);
 const q=await pool.query(`INSERT INTO deposits(user_id,amount,transfer_code) VALUES($1,$2,$3) RETURNING *`,[req.user.id,amount,code]);
 res.json({...q.rows[0],bank:{name:process.env.BANK_NAME||'',account:process.env.BANK_ACCOUNT||'',accountName:process.env.BANK_ACCOUNT_NAME||''}});
});
app.get('/api/deposits/mine',auth,async(req,res)=>res.json((await pool.query(`SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC`,[req.user.id])).rows));
app.post('/api/payments/webhook',async(req,res)=>{
 if(!process.env.PAYMENT_WEBHOOK_SECRET||req.headers['x-webhook-secret']!==process.env.PAYMENT_WEBHOOK_SECRET)return res.status(401).json({error:'Webhook không hợp lệ'});
 if(req.body.status!=='paid')return res.json({ok:true});
 const c=await pool.connect();try{await c.query('BEGIN');const d=(await c.query(`SELECT * FROM deposits WHERE transfer_code=$1 FOR UPDATE`,[req.body.transfer_code])).rows[0];if(!d||d.status==='paid'){await c.query('ROLLBACK');return res.json({ok:true})}await c.query(`UPDATE deposits SET status='paid',provider_ref=$1,paid_at=NOW() WHERE id=$2`,[req.body.provider_ref,d.id]);await c.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`,[d.amount,d.user_id]);await audit(c,d.user_id,'DEPOSIT_PAID','deposit',d.id,{amount:Number(d.amount)});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(500).json({error:'Lỗi webhook'})}finally{c.release()}
});

app.post('/api/withdrawals',auth,onlySeller,async(req,res)=>{
 const amount=Number(req.body.amount),bank=String(req.body.bank||''),accountNo=String(req.body.account_no||''),accountName=String(req.body.account_name||'');
 if(!Number.isInteger(amount)||amount<10000||!bank||!accountNo||!accountName)return res.status(400).json({error:'Thông tin rút không hợp lệ'});
 const c=await pool.connect();try{await c.query('BEGIN');const u=(await c.query(`SELECT seller_balance FROM users WHERE id=$1 FOR UPDATE`,[req.user.id])).rows[0];if(Number(u.seller_balance)<amount)throw Error('Số dư bán hàng không đủ');await c.query(`UPDATE users SET seller_balance=seller_balance-$1 WHERE id=$2`,[amount,req.user.id]);const w=await c.query(`INSERT INTO withdrawals(seller_id,amount,bank,account_no,account_name) VALUES($1,$2,$3,$4,$5) RETURNING id,status`,[req.user.id,amount,bank,accountNo,accountName]);await audit(c,req.user.id,'WITHDRAW_REQUEST','withdrawal',w.rows[0].id,{amount});await c.query('COMMIT');res.json(w.rows[0])}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});

app.get('/api/chat',auth,async(req,res)=>{
 const other=Number(req.query.with),product=Number(req.query.product||0);if(!other)return res.status(400).json({error:'Thiếu người nhận'});
 const ids=[req.user.id,other].sort((a,b)=>a-b),key=`u:${ids[0]}:${ids[1]}:p:${product}`;
 const q=await pool.query(`SELECT c.*,u.username sender FROM chats c JOIN users u ON u.id=c.sender_id WHERE thread_key=$1 ORDER BY c.id ASC LIMIT 300`,[key]);res.json(q.rows);
});
app.post('/api/chat',auth,async(req,res)=>{
 const other=Number(req.body.to),product=Number(req.body.product||0),message=String(req.body.message||'').trim().slice(0,1500);if(!other||!message)return res.status(400).json({error:'Tin nhắn không hợp lệ'});
 const ids=[req.user.id,other].sort((a,b)=>a-b),key=`u:${ids[0]}:${ids[1]}:p:${product}`;
 await pool.query(`INSERT INTO chats(thread_key,sender_id,recipient_id,product_id,message) VALUES($1,$2,$3,$4,$5)`,[key,req.user.id,other,product||null,message]);res.json({ok:true});
});

/* ADMIN */
app.get('/api/admin/stats',auth,onlyAdmin,async(req,res)=>{
 const [u,s,p,o]=await Promise.all([pool.query(`SELECT COUNT(*) c FROM users`),pool.query(`SELECT COUNT(*) c FROM users WHERE role='seller'`),pool.query(`SELECT COUNT(*) c FROM products WHERE status='approved'`),pool.query(`SELECT COUNT(*) c,COALESCE(SUM(amount),0) revenue,COALESCE(SUM(fee),0) fees FROM orders`)]);
 res.json({users:Number(u.rows[0].c),sellers:Number(s.rows[0].c),products:Number(p.rows[0].c),orders:Number(o.rows[0].c),revenue:Number(o.rows[0].revenue),fees:Number(o.rows[0].fees)});
});
app.get('/api/admin/users',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT id,username,email,role,status,seller_verification,balance,seller_balance,created_at FROM users ORDER BY id DESC LIMIT 500`)).rows));
app.get('/api/admin/seller-applications',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT a.*,u.username,u.email FROM seller_applications a JOIN users u ON u.id=a.user_id WHERE a.status='pending' ORDER BY a.id`)).rows));
app.post('/api/admin/seller-applications/:id/approve',auth,onlyAdmin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const a=(await c.query(`SELECT * FROM seller_applications WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!a)throw Error('Không tìm thấy hồ sơ');await c.query(`UPDATE seller_applications SET status='approved',updated_at=NOW() WHERE id=$1`,[a.id]);await c.query(`UPDATE users SET role='seller',seller_verification='verified' WHERE id=$1`,[a.user_id]);await audit(c,req.user.id,'APPROVE_SELLER','user',a.user_id,{});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(404).json({error:e.message})}finally{c.release()}
});
app.post('/api/admin/seller-applications/:id/reject',auth,onlyAdmin,async(req,res)=>{
 const a=(await pool.query(`SELECT * FROM seller_applications WHERE id=$1`,[req.params.id])).rows[0];if(!a)return res.status(404).json({error:'Không tìm thấy'});await pool.query(`UPDATE seller_applications SET status='rejected',admin_note=$1,updated_at=NOW() WHERE id=$2`,[String(req.body.note||''),a.id]);await pool.query(`UPDATE users SET seller_verification='rejected' WHERE id=$1`,[a.user_id]);res.json({ok:true});
});
app.get('/api/admin/products',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT p.id,p.game,p.title,p.price,p.status,p.created_at,u.username seller FROM products p JOIN users u ON u.id=p.seller_id ORDER BY p.id DESC LIMIT 500`)).rows));
app.post('/api/admin/products/:id/approve',auth,onlyAdmin,async(req,res)=>{await pool.query(`UPDATE products SET status='approved' WHERE id=$1 AND status='pending'`,[req.params.id]);res.json({ok:true})});
app.post('/api/admin/products/:id/reject',auth,onlyAdmin,async(req,res)=>{await pool.query(`UPDATE products SET status='rejected',admin_note=$1 WHERE id=$2 AND status='pending'`,[String(req.body.note||''),req.params.id]);res.json({ok:true})});
app.delete('/api/admin/products/:id',auth,onlyAdmin,async(req,res)=>{const q=await pool.query(`SELECT status FROM products WHERE id=$1`,[req.params.id]);if(!q.rowCount)return res.status(404).json({error:'Không tìm thấy'});if(q.rows[0].status==='sold')return res.status(400).json({error:'Không thể xóa acc đã bán'});await pool.query(`DELETE FROM products WHERE id=$1`,[req.params.id]);res.json({ok:true})});
app.post('/api/admin/users/:id/toggle-lock',auth,onlyAdmin,async(req,res)=>{const q=await pool.query(`SELECT id,role,status FROM users WHERE id=$1`,[req.params.id]);if(!q.rowCount||q.rows[0].role==='admin')return res.status(400).json({error:'Không thể thực hiện'});const status=q.rows[0].status==='active'?'suspended':'active';await pool.query(`UPDATE users SET status=$1 WHERE id=$2`,[status,req.params.id]);res.json({ok:true,status})});
app.get('/api/admin/orders',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT o.id,o.amount,o.fee,o.seller_net,o.status,o.created_at,p.title,b.username buyer,s.username seller FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id ORDER BY o.id DESC LIMIT 500`)).rows));
app.get('/api/admin/deposits',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT d.*,u.username FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 500`)).rows));
app.post('/api/admin/deposits/:id/approve',auth,onlyAdmin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const d=(await c.query(`SELECT * FROM deposits WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!d||d.status!=='pending')throw Error('Giao dịch không hợp lệ');await c.query(`UPDATE deposits SET status='paid',provider_ref=$1,paid_at=NOW() WHERE id=$2`,['ADMIN-'+Date.now(),d.id]);await c.query(`UPDATE users SET balance=balance+$1 WHERE id=$2`,[d.amount,d.user_id]);await audit(c,req.user.id,'ADMIN_APPROVE_DEPOSIT','deposit',d.id,{amount:Number(d.amount)});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/admin/withdrawals',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT w.*,u.username FROM withdrawals w JOIN users u ON u.id=w.seller_id ORDER BY w.id DESC LIMIT 500`)).rows));
app.post('/api/admin/withdrawals/:id/approve',auth,onlyAdmin,async(req,res)=>{const q=await pool.query(`UPDATE withdrawals SET status='paid',processed_at=NOW(),admin_note=$1 WHERE id=$2 AND status='pending' RETURNING *`,[String(req.body.note||''),req.params.id]);if(!q.rowCount)return res.status(400).json({error:'Yêu cầu không hợp lệ'});res.json({ok:true})});
app.post('/api/admin/withdrawals/:id/reject',auth,onlyAdmin,async(req,res)=>{
 const c=await pool.connect();try{await c.query('BEGIN');const w=(await c.query(`SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!w||w.status!=='pending')throw Error('Yêu cầu không hợp lệ');await c.query(`UPDATE withdrawals SET status='rejected',processed_at=NOW(),admin_note=$1 WHERE id=$2`,[String(req.body.note||''),w.id]);await c.query(`UPDATE users SET seller_balance=seller_balance+$1 WHERE id=$2`,[w.amount,w.seller_id]);await audit(c,req.user.id,'REJECT_WITHDRAWAL','withdrawal',w.id,{amount:Number(w.amount)});await c.query('COMMIT');res.json({ok:true})}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message})}finally{c.release()}
});
app.get('/api/admin/audit',auth,onlyAdmin,async(req,res)=>res.json((await pool.query(`SELECT a.*,u.username actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 500`)).rows));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>app.listen(PORT,'0.0.0.0',()=>console.log(`TAPHOAGAME_FINAL running on ${PORT}`)))
.catch(e=>{console.error('Startup failed:',e);process.exit(1)});
