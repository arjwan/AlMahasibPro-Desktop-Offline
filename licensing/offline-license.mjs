import crypto from 'node:crypto';
import fs from 'node:fs';

export const LICENSE_PRODUCT='almahasibpro-desktop-offline';
export function canonicalLicense(value){
 const {version,product,licenseId,customer,deviceHash,issuedAt,expiresAt=null}=value;
 if(version!==1||product!==LICENSE_PRODUCT||typeof licenseId!=='string'||!licenseId||typeof customer!=='string'||!customer||!(/^[a-f0-9]{64}$/).test(deviceHash)||!Number.isFinite(Date.parse(issuedAt))||(expiresAt!==null&&!Number.isFinite(Date.parse(expiresAt))))throw new Error('Invalid license details');
 return JSON.stringify({version,product,licenseId,customer,deviceHash,issuedAt,expiresAt});
}
export function verifyLicense(license,publicKeyPem,deviceHash){
 if(!license||typeof license!=='object'||typeof license.signature!=='string')return {ok:false,reason:'License signature missing'};
 try{
  const payload=canonicalLicense(license);
  const signature=Buffer.from(license.signature,'base64');
  if(signature.length!==64||!crypto.verify(null,Buffer.from(payload),publicKeyPem,signature))return {ok:false,reason:'Invalid license signature'};
  if(deviceHash!==license.deviceHash)return {ok:false,reason:'License belongs to a different computer'};
  if(license.expiresAt&&Date.now()>Date.parse(license.expiresAt))return {ok:false,reason:'License expired'};
  return {ok:true,licenseId:license.licenseId,customer:license.customer};
 }catch{return {ok:false,reason:'Invalid license format'};}
}
export function readAndVerifyLicense(filePath,publicKeyPem,deviceHash){
 try{return verifyLicense(JSON.parse(fs.readFileSync(filePath,'utf8')),publicKeyPem,deviceHash)}
 catch{return {ok:false,reason:'License file not found or unreadable'};}
}
