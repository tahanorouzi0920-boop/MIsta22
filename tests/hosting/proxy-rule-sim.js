// Mimics the Cloudflare _redirects rule: static files from public/, /api/* proxied to the backend on the same origin.
const http=require('http'),fs=require('fs'),path=require('path');
const PUB=path.join(__dirname,'..','..','public'), BACK={host:'127.0.0.1',port:(Number(process.env.BACKEND_PORT)||4061)};
http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname.startsWith('/api/')){
    const pr=http.request({...BACK,path:req.url,method:req.method,headers:req.headers},(br)=>{res.writeHead(br.statusCode,br.headers);br.pipe(res);});
    pr.on('error',()=>{res.writeHead(502);res.end('bad gateway');}); return req.pipe(pr);
  }
  const f=path.join(PUB,u.pathname==='/'?'index.html':u.pathname);
  if(!f.startsWith(PUB)||!fs.existsSync(f)){res.writeHead(404);return res.end('Not Found');}
  res.writeHead(200,{'Content-Type':f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':'text/html; charset=utf-8'});fs.createReadStream(f).pipe(res);
}).listen(4071,'127.0.0.1',()=>console.log('proxy-sim on 4071'));
