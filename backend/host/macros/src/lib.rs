//! `#[command]` + `generate_handler!` for the Electron host.
//!
//! Every command gets a hidden `__cmd__<name>` wrapper that pulls its
//! arguments out of an [`InvokeCtx`] (camelCase JSON keys) and injects the
//! special parameters (`State`, `AppHandle`, the calling `WebviewWindow`).
//! Sync commands run inline on the caller's thread (the Electron main
//! thread); async ones come back as a boxed future for the host runtime.

use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::{parse_macro_input, punctuated::Punctuated, FnArg, ItemFn, Pat, Path, Token, Type};

const SPECIAL: &[&str] = &["State", "AppHandle", "WebviewWindow", "Window", "Webview"];

fn last_segment(ty: &Type) -> Option<String> {
    match ty {
        Type::Path(p) => p.path.segments.last().map(|s| s.ident.to_string()),
        Type::Reference(r) => last_segment(&r.elem),
        _ => None,
    }
}

fn camel(name: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for (i, ch) in name.trim_start_matches('_').chars().enumerate() {
        if ch == '_' {
            upper = i > 0;
            continue;
        }
        if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[proc_macro_attribute]
pub fn command(attr: TokenStream, item: TokenStream) -> TokenStream {
    let func = parse_macro_input!(item as ItemFn);
    let snake = attr.to_string().contains("snake_case");
    let vis = &func.vis;
    let name = &func.sig.ident;
    let wrapper = format_ident!("__cmd__{}", name);
    let is_async = func.sig.asyncness.is_some();

    let mut binds = Vec::new();
    let mut call_args = Vec::new();
    for (i, arg) in func.sig.inputs.iter().enumerate() {
        let FnArg::Typed(pt) = arg else {
            return syn::Error::new_spanned(arg, "commands cannot take self")
                .to_compile_error()
                .into();
        };
        let ident = match &*pt.pat {
            Pat::Ident(pi) => pi.ident.to_string(),
            _ => format!("arg{i}"),
        };
        let var = format_ident!("__arg{}", i);
        let ty = &pt.ty;
        let special = last_segment(ty)
            .map(|s| SPECIAL.contains(&s.as_str()))
            .unwrap_or(false);
        if special {
            binds.push(quote! {
                let #var: #ty = ::host::__private::FromCtx::from_ctx(&__ctx)?;
            });
        } else {
            let key = if snake {
                ident.trim_start_matches('_').to_string()
            } else {
                camel(&ident)
            };
            binds.push(quote! {
                let #var: #ty = __ctx.arg(#key)?;
            });
        }
        call_args.push(quote!(#var));
    }

    let wrapper_fn = if is_async {
        quote! {
            #[doc(hidden)]
            #[allow(non_snake_case, clippy::all)]
            #vis fn #wrapper(__ctx: ::host::InvokeCtx) -> ::host::CommandOutput {
                ::host::CommandOutput::Future(::std::boxed::Box::pin(async move {
                    let __ctx = __ctx;
                    #(#binds)*
                    let __out = #name(#(#call_args),*).await;
                    #[allow(unused_imports)]
                    use ::host::__private::{ResultKind as _, SerializeKind as _};
                    (&__out).__cetus_kind().wrap(__out)
                }))
            }
        }
    } else {
        quote! {
            #[doc(hidden)]
            #[allow(non_snake_case, clippy::all)]
            #vis fn #wrapper(__ctx: ::host::InvokeCtx) -> ::host::CommandOutput {
                let __run = || -> ::std::result::Result<::host::__private::Value, ::host::__private::Value> {
                    #(#binds)*
                    let __out = #name(#(#call_args),*);
                    #[allow(unused_imports)]
                    use ::host::__private::{ResultKind as _, SerializeKind as _};
                    (&__out).__cetus_kind().wrap(__out)
                };
                ::host::CommandOutput::Ready(__run())
            }
        }
    };

    quote! {
        #func
        #wrapper_fn
    }
    .into()
}

/// `generate_handler![a::b, c]` → a dispatcher closure
/// `Fn(&str, InvokeCtx) -> Option<CommandOutput>`.
#[proc_macro]
pub fn generate_handler(input: TokenStream) -> TokenStream {
    let paths = parse_macro_input!(input with Punctuated::<Path, Token![,]>::parse_terminated);
    let mut arms = Vec::new();
    for path in paths {
        let mut wrapper = path.clone();
        let last = wrapper.segments.last_mut().expect("empty command path");
        let name = last.ident.to_string();
        last.ident = format_ident!("__cmd__{}", last.ident);
        arms.push(quote! { #name => ::std::option::Option::Some(#wrapper(__ctx)), });
    }
    quote! {
        |__cmd: &str, __ctx: ::host::InvokeCtx| -> ::std::option::Option<::host::CommandOutput> {
            match __cmd {
                #(#arms)*
                _ => ::std::option::Option::None,
            }
        }
    }
    .into()
}
