import "../lib/env";
import { capePackageInputs } from "../lib/cape/inputs";
import { buildPackage, capeInputsHash } from "../lib/cape/components";
async function main(){
  const inputs = await capePackageInputs();
  const ranked = inputs.slice().sort((a,b)=>b.lotCount-a.lotCount);
  console.log(`${inputs.length} packages pass the inventory rule\n`);
  console.log("top 12 by parcels:");
  for (const i of ranked.slice(0,12)) {
    const p = i.production;
    const fresh = p && p.hasVideo && p.inputsHash === capeInputsHash(i);
    console.log(`  ${String(i.lotCount).padStart(4)}  ${i.countyName}, ${i.state}  sale ${i.saleDate}  due ${buildPackage(i).deadline.dueDate}  ${fresh?'video current':(p?.hasVideo?'video stale':'no video')}`);
  }
  const ids = ranked.slice(0,12).map(i=>i.auctionId);
  console.log("\nauctionIds:\n" + ids.join("\n"));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e?.cause?.message??e);process.exit(1);});
