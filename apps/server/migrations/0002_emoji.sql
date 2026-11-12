-- AI が本文から選ぶ絵文字（アバター代わり）。tags と同じジョブ・同じ tags_version で付与する
ALTER TABLE memos ADD COLUMN emoji TEXT;
