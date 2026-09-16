#!/bin/bash
# Top 12 counties by parcel count. Fulton already has a current video.
IDS="
6981ed55-17c6-4d83-8e9d-91c5ff9e969a Duval_FL_228
ce7f446a-0022-47ad-a6ce-eef3071e4c4d Sandoval_NM_112
2be5a6ee-61e7-4672-9dc1-09a7d057b5ee Shawnee_KS_99
7137979f-c423-4dba-8b9a-deb15ccfcaa3 Escambia_FL_82
423fff04-5c3a-487a-9e1b-03e5f48a52f2 Harris_TX_81
27fceff0-3a38-487f-86aa-ec76f6a1702f PalmBeach_FL_74
0394c882-347d-4cb3-9f73-524a9c42df94 Putnam_FL_67
de779e93-53f4-4bdf-8f3f-49a5b1fb9675 Brevard_FL_65
30ec86de-a42c-40e1-85b8-088c3fbf5c67 Chaves_NM_64
f60ab9ce-d3da-4df1-a7b9-5b85896b1398 Hill_TX_58
a16910f7-7ff9-4d85-a028-bbe6f2520282 Charlotte_FL_52
"
echo "$IDS" | while read -r id name; do
  [ -z "$id" ] && continue
  echo "=== $name ($id) ==="
  npm run cape:produce -- --auction "$id" --motion opening 2>&1 \
    | grep -vE "injected env|^>|Warning|trace-warn|npm notice"
  echo
done
echo "=== ALL DONE ==="
