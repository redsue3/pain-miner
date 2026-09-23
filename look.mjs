import { readFileSync } from 'node:fs';
function pc(t){const r=[];let row=[],c='',q=false;for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch==='"'&&t[i+1]==='"'){c+='"';i++}else if(ch==='"')q=false;else c+=ch}else if(ch==='"')q=true;else if(ch===','){row.push(c);c=''}else if(ch==='\n'){row.push(c);r.push(row);row=[];c=''}else if(ch!=='\r')c+=ch}if(c||row.length){row.push(c);r.push(row)}return r}
const t=pc(readFileSync('./out/mined.csv','utf8').replace(/^﻿/,'')).filter(r=>r.length>1);
const h=t[0]; const recs=t.slice(1).map(r=>Object.fromEntries(h.map((k,i)=>[k,r[i]??''])));
const THEMES={
 '기프티콘·상품권':/기프티콘|기프트콘|상품권|기프트카드/,
 '영수증·정산':/현금영수증|영수증|정산|경비/,
 '입금·이체':/입금|이체|송금|계좌/,
 '구독·해지':/구독|정기결제|자동이체|해지|멤버십/,
 '검진·접종·병원':/건강검진|예방접종|검진|진료|처방|복용/,
 '유통기한·냉장고':/유통기한|소비기한|냉장고|식재료/,
 '차계부·연비':/차계부|연비|주유/,
 '주차':/주차/,
 '비번·인증':/비밀번호|비번|인증서|2단계|OTP|로그인/,
 '사진·파일':/사진\s*정리|갤러리|용량|백업|폴더/,
 '택배·배송':/택배|배송|운송장|반품/,
 '관리비·공과금':/관리비|공과금|전기요금|수도요금|가스비/,
 '보험·서류':/보험|증명서|서류|민원|신청서/,
 '가계부·지출':/가계부|소비내역|지출|카드값/,
 '일정·기념일':/일정|기념일|생일|캘린더|알림/,
};
const dom=r=>{for(const[k,v]of Object.entries(THEMES))if(v.test(r.title))return k;return null};
const g={};
for(const r of recs){const d=dom(r); if(d)(g[d]=g[d]||[]).push(r)}
for(const[k,v]of Object.entries(g).sort((a,b)=>b[1].length-a[1].length)){
  console.log('\n■ '+k+'  '+v.length+'건');
  v.sort((a,b)=>b.score-a.score||b.date.localeCompare(a.date)).slice(0,7)
   .forEach(r=>console.log('  '+r.date+' ['+r.id+'] '+r.title.slice(0,64)));
}
console.log('\n전체 '+recs.length+'건 / 주제분류됨 '+Object.values(g).reduce((a,b)=>a+b.length,0)+'건');
