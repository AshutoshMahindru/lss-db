(ns repair-related-to-placeholder-values
  (:require [clojure.string :as str]
            [datascript.core :as d]
            [logseq.db :as ldb]
            [logseq.db.common.sqlite-cli :as sqlite-cli]))

(def related-to-ident :plugin.property.logseq-lss-db-final-plugin/related-to)

(def placeholder-titles
  #{"LSS Placeholder - related-to"
    "LSS Placeholder/related-to"
    "Tags"
    "related-to"})

(defn die [& parts]
  (println (str/join " " parts))
  (js/process.exit 1))

(defn value-title [db value]
  (let [entity (d/entity db value)]
    (or (:block/title entity) (:block/name entity) "")))

(let [[graph & _flags] *command-line-args*]
  (when (or (nil? graph) (= graph "--help"))
    (die "Usage: nbb-logseq -cp <logseq-cli-vendor-src> scripts/repair-related-to-placeholder-values.cljs GRAPH"))
  (let [conn (apply sqlite-cli/open-db! (sqlite-cli/->open-db-args graph))
        db @conn
        rows (->> (d/q '[:find ?page ?value
                         :where [?page :plugin.property.logseq-lss-db-final-plugin/related-to ?value]]
                       db)
                  (filter (fn [[_ value]] (contains? placeholder-titles (value-title db value))))
                  vec)
        tx (mapv (fn [[page value]] [:db/retract page related-to-ident value]) rows)]
    (if (seq tx)
      (do
        (ldb/transact! conn tx)
        (println "Removed placeholder related-to values:" (count tx))
        (doseq [[page value] rows]
          (let [p (d/entity db page)]
            (println (or (:block/title p) (:block/name p) page) "->" (value-title db value)))))
      (println "No placeholder related-to values found."))))
