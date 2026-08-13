import { Card } from "@/components/ui";
import type { InventorySnapshot } from "@/lib/admin/ops";

export function InventoryPanel({ inventory }: { inventory: InventorySnapshot }) {
  return (
    <>

        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-border">
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3 text-right">Auctions</th>
                  <th className="py-2 pr-3 text-right">Parcels held</th>
                  <th className="py-2 pr-3 text-right">Biddable auctions</th>
                </tr>
              </thead>
              <tbody>
                {inventory.states.map((s) => (
                  <tr key={s.state} className="border-b border-border/50 last:border-0">
                    <td className="py-1.5 pr-3 font-medium">{s.state}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.auctions.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.parcels.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {s.inventory > 0 ? s.inventory : <span className="text-muted">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      
    </>
  );
}
