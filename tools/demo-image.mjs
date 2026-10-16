// Code-native package icons for the isolated demo catalog; no remote images.
import {deflateSync} from 'node:zlib';
export function demoImage(index,category){
 const w=160,h=120,rgba=Buffer.alloc(w*h*4),colors=[[218,168,70],[76,150,87],[85,147,202],[223,111,79],[170,101,157],[62,169,164],[116,139,201],[195,132,77],[84,155,192],[184,142,72],[221,155,57],[92,108,130]],color=colors[category];
 function rect(x,y,width,height,c){for(let yy=Math.max(0,y);yy<Math.min(h,y+height);yy++)for(let xx=Math.max(0,x);xx<Math.min(w,x+width);xx++){const p=(yy*w+xx)*4;rgba[p]=c[0];rgba[p+1]=c[1];rgba[p+2]=c[2];rgba[p+3]=255}}
 rect(0,0,w,h,[246,248,252]);rect(38,105,84,5,[218,222,229]);
 const shape=category%4;
 if(shape===0){rect(44,22,72,80,color);rect(44,18,72,8,[58,69,87]);rect(50,34,60,46,[255,253,244])}
 if(shape===1){rect(53,30,54,73,color);rect(62,17,36,15,color);rect(64,10,32,9,[58,69,87]);rect(58,48,44,32,[255,253,244])}
 if(shape===2){rect(48,19,64,84,color);rect(45,15,70,7,[175,183,194]);rect(45,100,70,5,[175,183,194]);rect(52,39,56,38,[255,253,244])}
 if(shape===3){rect(39,27,82,75,color);rect(47,18,66,10,color);rect(45,46,70,31,[255,253,244])}
 rect(67,52,26,5,color);rect(62,62,36,4,color);for(let i=0;i<18;i++)if((i+index)%3)rect(56+i*3,86,1,10,[47,56,72]);
 const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
 const crc=b=>{let n=0xffffffff;for(const v of b)n=table[(n^v)&255]^(n>>>8);return(n^0xffffffff)>>>0};
 const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([len,t,data,sum])};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
 const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)rgba.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
