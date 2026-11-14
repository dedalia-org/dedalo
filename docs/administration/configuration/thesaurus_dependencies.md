# Thesaurus dependencies

> See also: [Configuration](index.md) · [Installing new hierarchies](../install_new_hierarchies.md)

Dédalo uses different models for each heritage field. For example, to build a tangible catalogue of an archaeological collection you implement the `tch` (tangible cultural heritage) ontology model (tld); to work with numismatic heritage you implement `numisdata`; to build an interview archive you implement the `oh` tld, and so on.

All of these ontology definitions consume thesauri, so each ontology model depends on certain thesauri.

## Why thesauri do not use the main tld

The short answer: a thesaurus can be shared across disciplines.

The longer answer: if a thesaurus used the same tld as the catalogue model, implementing that tld would also implement the whole model — with every section and field, even the ones you don't want.

For example, the `tch` model uses the `material` thesaurus. It might seem that `material` should carry the `tch` tld so it gets implemented alongside `tch`. But `material` is also used by the numismatic model `numisdata`; if it carried the `tch` tld, implementing the thesaurus would drag in the full `tch` model, which you don't want.

A thesaurus can also be shared between projects and installations, so it needs its own tld.

## Dependencies

The next table show the dependencies between main catalog tld and thesaurus tld.

| Thesaurus name | Typology | tld | tch | tchi | ich | numisdata | oh | isad | dmm |
| --- | --- | --- |  --- |  --- |  --- |  --- |  --- |  --- |  --- |
| Art Style | Thematic | style | √ | * | * | * | * | * | * |
| Chronology | Thematic | dc | √ | √ | √ | √ | √ | √ | √ |
| Culture | Thematic | culture | √ | √ | √ | √ | x | x | x |
| Deposition type | Thematic | depositiontype | x | x | x | √ | x | x | x |
| Enrollment Position | Thematic | pieces | √ | x | x | x | x | x | x |
| Iconography | Thematic | icon | √ | √ | √ | √ | x | x | x |
| Immovable property | Thematic | tchi | √ | √ | √ | √ | x | x | x |
| Material | Thematic | material | √ | √ | √ | √ | x | x | x |
| Onomastic | Thematic | on | √ | √ | √ | √ | √ | √ | √ |
| Site category | Thematic | tchicategory | x | √ | x | √ | x | x | x |
| Site context | Thematic | tchicontext | x | √ | x | √ | x | x | x |
| Technique | Thematic | technique | √ | √ | √ | √ | x | x | x |
| Thematic | Thematic | ts | √ | √ | √ | √ | √ | √ | √ |
| Ceramic | Typology | ceramic | √ | * | x | * | x | x | x |
| Object | Typology | object | √ | √ | √ | √ | x | x | x |
| Flora | Typology | flora | √ | √ | √ | √ | x | x | x |
| Fauna | Typology | fauna | √ | √ | √ | √ | x | x | x |
| Numismatic | Typology | numismatic | √ | √ | x | √ | x | x | x |
| ISAD(g) | Catalog | isad | x | x | x | x | x | √ | x |
| Location | Ubications | ubication | √ | √ | x | √ | x | x | x |
| Historical toponymy | Toponymy | htoponymy | √ | √ | x | √ | * | * | * |
| Cause of uncertainty | Semantics | uncertainty | x | x | x | √ | x | x | x |
| Job roles | Semantics | rolejob | √ | √ | √ | √ | √ | √ | √ |
| Position roles | Semantics | rolepos | √ | √ | √ | √ | √ | √ | √ |
| Semantic | Semantics | ds | √ | √ | √ | √ | √ | √ | √ |
| User roles | Semantics | roleusr | √ | √ | √ | √ | √ | √ | √ |
| Special | Special | special | x | x | x | x | √ | x | x |
| Analysis | Laboratory \| Restoration | labanalysis | √ | √ | x | x | x | x | x |
| Cause | Laboratory \| Restoration | rescause | √ | √ | x | x | x | x | x |
| Job material | Laboratory \| Restoration | resmaterial | √ | √ | x | x | x | x | x |
| Pathology | Laboratory \| Restoration | respathology | √ | √ | x | x | x | x | x |
| Treatment | Laboratory \| Restoration | restreatment | √ | √ | x | x | x | x | x |
| Countermarks | Epigraphy | sccmk | x | x | x | √ | x | x | x |
| Greek | Epigraphy | scell | x | x | x | √ | x | x | x |
| Latin | Epigraphy | sclat | x | x | x | √ | x | x | x |
| Northern Paleohispanic | Epigraphy | scxibo | x | x | x | x | x | x | x |
| Punic | Epigraphy | scxpu | x | x | x | √ | x | x | x |
| Southern Paleohispanic | Epigraphy | scxibm | x | x | x | x | x | x | x |
| Southwest Paleohispanic | Epigraphy | sctxr | x | x | x | x | x | x | x |
| Symbol | Epigraphy | scsym | x | x | x | √ | x | x | x |
| Web sites | Websites | ww |  x | x | x | x | x | x | x |

- √ The thesaurus is used and called directly
- X The thesaurus is not used directly
- \* The thesaurus may or may not be used, depending on the project. The thesaurus is called by the components through their typology.

The above table shows required dependencies for the main tlds, but it is possible to implement more thesaurus than those required, for example, if you want to work with epigraphic legends in amphorae with Greek thesaurus when you are working with the `tch` catalogue, you can implement it.

## How implement?

Thesaurus is a flexible and extensible system. Main definitions with tld and ontology creation is managed and controlled by the `Hierarchies` section [hierarchy1](https://dedalo.dev/ontology/hierarchy1). You can add new registers and create new thesaurus to be used in specific way.

Some thesauri are common to every installation: the Languages thesaurus (`lg`) is active on every install and is not a choice. Others are common but chosen per installation, such as the official toponymy: one installation works with the Spanish toponymy, another with the French or the Japanese one, or with a mix of the countries Dédalo ships. Choose them during the install (the installer's optional-thesauri answer, `--hierarchies` on the command line, Spain by default) or later from the [maintenance panel](../install_new_hierarchies.md), at any time.

The table above is about thesauri, which are data. The **ontologies** a domain ontology needs (for example the ones `tch` builds on) are a different thing: the installer installs those with the domain ontology you choose, when the ontology server declares them (see [Domain ontologies](../../install/installer_reference.md#domain-ontologies)).
