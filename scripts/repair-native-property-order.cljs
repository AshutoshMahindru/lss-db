(ns repair-native-property-order
  (:require [clojure.string :as str]
            [datascript.core :as d]
            [logseq.db :as ldb]
            [logseq.db.common.order :as db-order]
            [logseq.db.common.sqlite-cli :as sqlite-cli]
            [logseq.db.frontend.validate :as db-validate]))

(def plugin-ns "plugin.property.logseq-lss-db-final-plugin")

(def hierarchy-related
  {"related-area" 0
   "related-function" 1
   "related-project" 2
   "related-workstream" 3
   "related-team" 4
   "related-venture" 5
   "related-proposal" 6})

(defn die [& parts]
  (println (str/join " " parts))
  (js/process.exit 1))

(defn prop-ident [property-name]
  (keyword plugin-ns property-name))

(defn property-rank [property-name]
  (cond
    (= property-name "lss-object-type") [0 0 property-name]
    (#{"area" "areas"} property-name) [1 (if (= property-name "area") 0 1) property-name]
    (contains? hierarchy-related property-name) [2 (get hierarchy-related property-name) property-name]
    (and (str/starts-with? property-name "related-") (not= property-name "related-to")) [2 100 property-name]
    (= property-name "owner") [3 0 property-name]
    (= property-name "related-to") [3 1 property-name]
    (= property-name "status") [5 0 property-name]
    :else [4 0 property-name]))

(defn existing-plugin-properties [db]
  (->> (d/q '[:find ?title
              :in $ ?ns
              :where
              [?p :db/ident ?ident]
              [(namespace ?ident) ?ns]
              [?p :block/title ?title]]
            db plugin-ns)
       (map first)
       (remove str/blank?)
       distinct
       (sort-by property-rank)
       vec))

(defn validate-db! [conn db-name]
  (if-let [errors (:errors (db-validate/validate-local-db! @conn {:db-name db-name :verbose true}))]
    (do
      (println "Found" (count errors) "validation error(s)")
      (js/console.error (pr-str errors))
      (js/process.exit 1))
    (println "Valid!")))

(let [[graph & flags] *command-line-args*
      validate? (contains? (set flags) "--validate")]
  (when (or (nil? graph) (= graph "--help"))
    (die "Usage: nbb-logseq -cp <logseq-cli-vendor-src> scripts/repair-native-property-order.cljs GRAPH [--validate]"))
  (let [open-args (sqlite-cli/->open-db-args graph)
        db-name (if (= 1 (count open-args)) (first open-args) (second open-args))
        conn (apply sqlite-cli/open-db! open-args)
        db @conn
        property-names (existing-plugin-properties db)
        orders (db-order/gen-n-keys (count property-names) nil nil)
        tx (->> (map vector property-names orders)
                (map
                 (fn [[property-name wanted]]
                   (let [attr (prop-ident property-name)
                         current (:block/order (d/entity db attr))]
                     (when (not= current wanted)
                       [:db/add attr :block/order wanted]))))
                (remove nil?)
                vec)]
    (when (empty? property-names)
      (die "No plugin property definitions found for namespace:" plugin-ns))
      (if (seq tx)
        (do
          (ldb/transact! conn tx)
          (println "Updated native property order entries:" (count tx)))
        (println "Native property order already canonical."))
      (doseq [property-name property-names]
        (let [entity (d/entity @conn (prop-ident property-name))]
          (println property-name (:block/order entity))))
      (when validate?
        (validate-db! conn db-name))))
