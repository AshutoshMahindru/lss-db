(ns logseq.clj-fractional-indexing)

(def base-62-digits "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")

(defn generate-key-between
  [_start _end]
  "U")

(defn generate-n-keys-between
  [_start _end n]
  (vec (for [index (range n)] (str "U" index))))

(defn validate-order-key
  [_key _digits]
  true)
