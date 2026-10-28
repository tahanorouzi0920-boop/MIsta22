// Mimics a static host (Cloudflare Pages without a backend): files from public/, everything else 404.
const http=require('http'),fs=require('fs'),path=require('path');
const PUB=path.join(__dirname,'..','..','public');
http.createServer((req,res)=>{
  const p=new URL(req.url,'http://x').pathname; const f=path.join(PUB,p==='/'?'index.html':p);
  if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404,{'Content-Type':'text/plain'});return res.end('Not Found');}
  res.writeHead(200,{'Content-Type':f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html; charset=utf-8'});fs.createReadStream(f).pipe(res);
}).listen(4070,'127.0.0.1',()=>console.log('static-only on 4070'));
