# kotlinx.serialization — keep @Serializable metadata for the wire model.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-keepclassmembers class jp.developershub.dub.mo2.core.model.** {
    *** Companion;
}
-keepclasseswithmembers class jp.developershub.dub.mo2.core.model.** {
    kotlinx.serialization.KSerializer serializer(...);
}
