# Collateral mutation record

43 of 43 mutants killed by `cargo test --lib collateral` in verifier/.
Each row removes or inverts one guard in `src/collateral.rs` or the entry in `src/lib.rs`; a mutant is killed when a test fails.

| Guard removed or inverted | Result | First failing test |
|---|---|---|
| document signature checked | killed | a_signature_does_not_transfer_between_documents |
| signer certificate chained to the root | killed | a_signer_not_issued_by_the_root_is_refused |
| signer must be named Intel SGX TCB Signing | killed | a_pck_ca_certificate_cannot_stand_in_for_the_tcb_signer |
| signer certificate validity window | killed | an_expired_tcb_signer_certificate_is_refused |
| root CRL covers the TCB Info signer | killed | a_revoked_tcb_signer_is_refused |
| root CRL covers the QE Identity signer | killed | a_revoked_qe_identity_signer_is_refused_on_its_own |
| root CRL covers the PCK CA | killed | a_revoked_pck_ca_is_refused |
| PCK CRL consulted | killed | a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused |
| PCK CRL lists the PCK leaf | killed | a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused |
| PCK CRL signed by the quote's CA | killed | a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused |
| CRL signature checked | killed | a_pck_crl_in_the_root_crl_slot_is_rejected |
| CRL thisUpdate | killed | collateral_outside_its_validity_window_is_rejected |
| CRL nextUpdate | killed | collateral_outside_its_validity_window_is_rejected |
| CRL membership | killed | a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused |
| Revoked never passes | killed | a_revoked_platform_never_passes_whatever_the_ceiling |
| status ceiling | killed | an_out_of_date_platform_is_refused_until_the_owner_accepts_that_status |
| QE status counts | killed | a_revoked_platform_never_passes_whatever_the_ceiling |
| module status counts | killed | tdx_module_identity_decides_the_module_level |
| Revoked rank | killed | a_revoked_platform_never_passes_whatever_the_ceiling |
| OutOfDate rank | killed | an_out_of_date_platform_is_refused_until_the_owner_accepts_that_status |
| TCB Info id and version | killed | tcb_info_for_another_platform_or_kind_is_rejected |
| FMSPC pinned | killed | tcb_info_for_another_platform_or_kind_is_rejected |
| issueDate | killed | document_freshness_boundaries_are_exact |
| nextUpdate is exclusive | killed | document_freshness_boundaries_are_exact |
| evaluation number floor | killed | a_minimum_evaluation_number_refuses_older_documents |
| module signer pinned | killed | a_foreign_tdx_module_signer_is_rejected |
| module attributes pinned | killed | the_tdx_module_signer_and_attributes_are_pinned |
| module attribute bits outside the mask | killed | bits_outside_the_module_attribute_mask_must_be_clear |
| module SVNs left to module identity | killed | tdx_module_identity_decides_the_module_level |
| module identity ISVSVN | killed | tdx_module_identity_decides_the_module_level |
| PCESVN compared | killed | a_platform_below_every_listed_level_matches_nothing |
| CPUSVN compared | killed | an_out_of_date_platform_is_refused_until_the_owner_accepts_that_status |
| TEE_TCB_SVN compared | killed | the_td_tcb_svn_components_select_the_level |
| QE identity id and version | killed | qe_identity_policy_follows_the_report |
| QE MRSIGNER pinned | killed | qe_identity_policy_follows_the_report |
| QE ISVPRODID pinned | killed | qe_identity_policy_follows_the_report |
| QE MISCSELECT pinned | killed | qe_miscselect_is_pinned_under_its_mask |
| QE ATTRIBUTES pinned | killed | qe_identity_policy_follows_the_report |
| QE ISVSVN level | killed | a_clean_chain_passes_and_a_revoked_pck_leaf_is_refused |
| entry runs the quote verification first | killed | real_collateral_reports_up_to_date |
| entry forwards the status ceiling | killed | the_entry_forwards_both_ceilings_and_the_signer |
| entry forwards the evaluation floor | killed | the_entry_forwards_both_ceilings_and_the_signer |
| entry uses Intel's root | killed | a_pck_crl_in_the_root_crl_slot_is_rejected |
