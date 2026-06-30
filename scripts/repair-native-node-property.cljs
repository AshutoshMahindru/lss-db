(ns repair-native-node-property
  (:require [clojure.string :as str]
            [datascript.conn :as dc]
            [datascript.core :as d]
            [logseq.db.common.sqlite-cli :as sqlite-cli]))

(def plugin-ns "plugin.property.logseq-lss-db-final-plugin")

(defn die [& parts]
  (println (str/join " " parts))
  (js/process.exit 1))

(defn entity-id [value]
  (cond
    (number? value) value
    (map? value) (:db/id value)
    :else (:db/id value)))

(defn prop-ident [property-name]
  (keyword plugin-ns property-name))

(def valid-property-types #{"node" "date" "default" "number" "url" "checkbox"})

(defn page-like? [db id]
  (let [entity (d/entity db id)]
    (boolean (or (:block/title entity) (:block/name entity)))))

(defn class-id [db title]
  (or
   (d/q '[:find ?class .
          :in $ ?title
          :where
          [?class :block/title ?title]
          [?class :block/tags :logseq.class/Tag]]
        db title)
   (d/q '[:find ?class .
          :in $ ?title
          :where
          [?class :block/title ?title]
          [?class :block/tags ?tag]
          [?tag :block/title "Tag"]]
        db title)))

(defn class-ids [db titles]
  (->> titles
       (map str/trim)
       (remove str/blank?)
       (map (fn [title] [title (class-id db title)]))
       vec))

(defn captured-values [db attr property-id]
  (->> (d/q '[:find ?entity ?old-value
              :in $ ?attr
              :where [?entity ?attr ?old-value]]
            db attr)
       (map
        (fn [[entity old-value]]
          (let [old-entity (d/entity db old-value)
                created-from (entity-id (:logseq.property/created-from-property old-entity))
                wrapped? (= created-from property-id)
                target (if wrapped? (:logseq.property/value old-entity) old-value)]
            {:entity entity
             :old-value old-value
             :target target
             :wrapped? wrapped?})))
       (sort-by (juxt :entity :target :old-value))
       vec))

(defn existing-classes [db property-id]
  (d/q '[:find [?class ...]
         :in $ ?property
         :where [?property :logseq.property/classes ?class]]
       db property-id))

(defn validate-db! [conn db-name]
  (println "Skipped in-script validation for" db-name "- run `logseq graph validate` after repair."))

(let [[graph property-name type-or-target maybe-target & flags*] *command-line-args*
      explicit-type? (contains? valid-property-types (str/lower-case (str type-or-target)))
      property-type (if explicit-type? (str/lower-case (str type-or-target)) "node")
      target-class (if (= "node" property-type)
                     (if explicit-type? maybe-target type-or-target)
                     nil)
      flags (cond
              (and explicit-type? (not= "node" property-type) (some? maybe-target)) (cons maybe-target flags*)
              explicit-type? flags*
              :else (cons maybe-target flags*))
      flag-set (set flags)
      validate? (contains? flag-set "--validate")
      drop-empty? (contains? flag-set "--drop-empty")
      drop-invalid? (contains? flag-set "--drop-invalid")]
  (when (or (nil? graph) (nil? property-name) (nil? type-or-target) (= graph "--help"))
    (die "Usage: nbb-logseq -cp <logseq-cli-vendor-src> scripts/repair-native-node-property.cljs GRAPH PROPERTY TARGET_CLASS [--validate]\n"
         "   or: nbb-logseq -cp <logseq-cli-vendor-src> scripts/repair-native-node-property.cljs GRAPH PROPERTY TYPE [TARGET_CLASS] [--validate]"))
  (when (and (= "node" property-type) (str/blank? (str target-class)))
    (die "Node property repair requires TARGET_CLASS."))
  (let [open-args (sqlite-cli/->open-db-args graph)
        db-name (if (= 1 (count open-args)) (first open-args) (second open-args))
        conn (apply sqlite-cli/open-db! open-args)
        db @conn
        attr (prop-ident property-name)
        property-entity (d/entity db attr)
        property-id (:db/id property-entity)
        target-classes (when target-class (str/split (str target-class) #","))
        target-class-pairs (when target-classes (class-ids db target-classes))
        target-class-ids (map second target-class-pairs)]
    (when-not property-id
      (die "Property not found:" property-name attr))
    (when (and (= "node" property-type) (some nil? target-class-ids))
      (die "Target class not found:" (pr-str (filter (fn [[_ id]] (nil? id)) target-class-pairs))))
    (let [all-captured (captured-values db attr property-id)
          dropped-empty (if drop-empty? (filter #(nil? (:target %)) all-captured) [])
          after-empty (if drop-empty? (remove #(nil? (:target %)) all-captured) all-captured)
          invalid-captured (if (#{"node" "date"} property-type)
                             (remove #(page-like? db (:target %)) after-empty)
                             [])
          dropped-invalid (if drop-invalid? invalid-captured [])
          captured (if drop-invalid?
                     (remove (set invalid-captured) after-empty)
                     after-empty)
          invalid (if drop-invalid? [] invalid-captured)
          unique-restores (->> captured
                               (map (juxt :entity :target))
                               distinct
                               (map (fn [[entity target]] {:entity entity :target target}))
                               vec)
          wrappers (->> all-captured
                        (filter :wrapped?)
                        (map :old-value)
                        distinct
                        vec)
          tx (vec
              (concat
               (map (fn [{:keys [entity old-value]}] [:db/retract entity attr old-value]) all-captured)
               (map (fn [{:keys [entity old-value]}] [:db/retract entity :block/refs old-value]) all-captured)
               (when-let [old-type (:logseq.property/type property-entity)]
                 [[:db/retract attr :logseq.property/type old-type]])
               [[:db/add attr :logseq.property/type (keyword property-type)]
                [:db/add attr :logseq.property/hide? false]]
               (map (fn [class] [:db/retract attr :logseq.property/classes class])
                    (existing-classes db property-id))
               (map (fn [target-class-id] [:db/add attr :logseq.property/classes target-class-id])
                    target-class-ids)
               (mapcat
                (fn [{:keys [entity target]}]
                  [[:db/add entity attr target]
                   [:db/add entity :block/refs property-id]
                   [:db/add entity :block/refs target]])
                unique-restores)
               (map (fn [wrapper] [:db/retractEntity wrapper]) wrappers)))]
      (when (seq invalid)
        (die "Aborting; unresolved target value(s):" (pr-str (take 10 invalid))))
      (if (seq tx)
        (do
          (let [tx-report (d/transact! conn tx {:skip-validate-db? true})]
            (dc/store-after-transact! conn tx-report))
          (println "Repaired" property-name
                   "type=" property-type
                   "captured=" (count captured)
                   "dropped-empty=" (count dropped-empty)
                   "dropped-invalid=" (count dropped-invalid)
                   "restored=" (count unique-restores)
                   "removed-wrappers=" (count wrappers)
                   "tx=" (count tx)))
        (println "No repair tx required for" property-name))
      (when validate?
        (validate-db! conn db-name)))))
